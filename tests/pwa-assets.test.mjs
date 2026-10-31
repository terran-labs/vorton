import { buildFixture, hostFixture, raw } from "./pwa-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { pwaHash, validatePwaInventory } from "../server/pwa-assets.mjs";
import { renderWorker } from "../scripts/pwa-worker-template.mjs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

test("portable PWA control endpoints deliver exact no-store bytes and runtime headers", async t => {
  for (const variant of ["portable"]) {
    const { base, files, config } = await hostFixture(t, variant);
    const session = await (await fetch(base + "/api/session")).json();
    for (const url of ["/sw.js", "/offline-assets.json", "/offline-shell.html", "/manifest.webmanifest"]) {
      const response = await raw(base, url);
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-vorton-installation-id"], session.installationId);
      assert.equal(response.headers["x-vorton-variant"], variant);
      assert.equal(response.headers["x-vorton-build-id"], config.buildId);
      assert.equal(response.headers["x-vorton-inventory-sha256"], config.inventorySha256);
      assert.equal(response.body.toString(), files.get(url).body);
      const head = await raw(base, url, {}, "HEAD");
      assert.equal(head.status, 200); assert.equal(head.body.length, 0);
      assert.equal(Number(head.headers["content-length"]), response.body.length);
      assert.equal((await raw(base, url, {}, "POST")).status, 405);
    }
    assert.equal((await raw(base, "/sw.js")).headers["service-worker-allowed"], "/");
    const shell = await raw(base, "/offline-shell.html");
    assert.match(shell.headers["content-security-policy"], /worker-src 'self'; manifest-src 'self'/);
    assert.equal((await raw(base, "/manifest.webmanifest")).headers["content-type"], "application/manifest+json");
    assert.equal((await raw(base, "/api/session")).headers["cache-control"], "no-store");
  }
});

test("PWA routes retain host/origin/path confinement and reject unpublished or development controls", async t => {
  for (const variant of ["portable"]) {
    const { base, dist } = await hostFixture(t, variant);
    for (const headers of [{ Origin: "https://foreign.example" }, { Host: "foreign.example" }, { "Sec-Fetch-Site": "cross-site" }])
      assert.equal((await raw(base, "/sw.js", headers)).status, 403);
    for (const route of ["/server/rolodex.mjs", "/sw.js/extra", "/%73w.js", "/x/../sw.js", "/sw%2ejs", "/unknown/bridge"])
      assert.equal((await raw(base, route)).status, 404, route);
    await rm(path.join(dist, "sw.js"));
    await writeFile(path.join(dist, "server-only.mjs"), "synthetic server module");
    await symlink("server-only.mjs", path.join(dist, "sw.js"));
    assert.equal((await raw(base, "/sw.js")).status, 404);
  }
});

test("missing, mismatched and corrupt control output fails without exposing alternate files", async t => {
  const { base, dist, inventory } = await hostFixture(t);
  await writeFile(path.join(dist, "index.html"), "different shell");
  assert.equal((await raw(base, "/offline-shell.html")).status, 503);
  await writeFile(path.join(dist, "offline-assets.json"), JSON.stringify({ ...inventory, variant: "private" }));
  assert.equal((await raw(base, "/offline-assets.json")).status, 503);
  await writeFile(path.join(dist, "offline-assets.json"), " ".repeat(512 * 1024 + 1));
  assert.equal((await raw(base, "/offline-assets.json")).status, 503);
  await rm(path.join(dist, "offline-assets.json"));
  assert.equal((await raw(base, "/sw.js")).status, 404);
});

test("inventory allowlist denies API/private JSON/server paths, malformed entries and excessive bounds", () => {
  const { inventory } = buildFixture("private");
  assert.equal(validatePwaInventory(inventory, "private"), inventory);
  for (const url of ["/api/session", "/dashboard-manifest.json", "/dashboard-views/secret.json", "/server/rolodex.mjs", "/assets/../server/code.js", "/assets/%2e%2e/code.js", "https://foreign.example/app.js", "/demo-assets/app.js"]) {
    const entries = [...inventory.entries, { ...inventory.entries[0], url }].sort((a, b) => a.url < b.url ? -1 : 1);
    assert.throws(() => validatePwaInventory({ ...inventory, entries }, "private"), undefined, url);
  }
  assert.throws(() => validatePwaInventory({ ...inventory, entries: [...inventory.entries].reverse() }, "private"));
  assert.throws(() => validatePwaInventory({ ...inventory, entries: inventory.entries.map(e => ({ ...e, size: 8 * 1024 * 1024 + 1 })) }, "private"));
  assert.throws(() => validatePwaInventory({ ...inventory, entries: [inventory.entries[0], ...inventory.entries] }, "private"));
  assert.throws(() => validatePwaInventory({ ...inventory, entries: inventory.entries.map(e => ({ ...e, contentType: "application/json" })) }, "private"));
});

test("staged inventory validates roles and permits the SQLite WASM asset", () => {
  const { inventory } = buildFixture("portable", "staged", true);
  const wasm = { url: "/demo-assets/sqlite.wasm", sha256: pwaHash("wasm"), size: 4, contentType: "application/wasm", role: "offline" };
  const entries = [...inventory.entries, wasm];
  // Use the same bytewise ordering as the build, independent of locale.
  entries.sort((a, b) => a.url < b.url ? -1 : 1);
  assert.doesNotThrow(() => validatePwaInventory({ ...inventory, entries }, "portable"));
  assert.throws(() => validatePwaInventory({ ...inventory, entries: inventory.entries.map(e => ({ ...e, role: "unknown" })) }, "portable"));
  assert.throws(() => validatePwaInventory({ ...inventory, entries: inventory.entries.map(e => e.url === "/offline-shell.html" ? { ...e, role: "optional" } : e) }, "portable"));
});

function memoryCaches() {
  const stores = new Map();
  return {
    stores,
    async keys() { return [...stores.keys()]; },
    async delete(key) { return stores.delete(key); },
    async open(key) {
      if (!stores.has(key)) stores.set(key, new Map());
      const store = stores.get(key);
      return {
        async match(url) { return store.get(url)?.clone(); },
        async put(url, response) { store.set(url, response.clone()); },
        async delete(url) { return store.delete(url); },
      };
    },
  };
}

function simulatedWorker(build, storage = memoryCaches(), sourceUrl = "http://fixture.test/lastresort/bridge", probe, networkHook, activationGate) {
  const origin = "http://fixture.test", handlers = new Map(), requests = [], background = [];
  let activationRequests = 0;
  let requested;
  const firstActivationRequest = new Promise(resolve => { requested = resolve; });
  const installing = Object.assign(new EventTarget(), { state: "installing" });
  const network = async (input, options) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push(url);
    if (probe && options?.method === "HEAD") return probe(options);
    const hooked = networkHook?.(url, options);
    if (hooked) return hooked;
    const file = build.files.get(new URL(url).pathname) ?? (input.mode === "navigate" ? build.files.get("/offline-shell.html") : undefined);
    if (!file) return new Response("network fixture", { status: 404 });
    return new Response(file.body, { headers: { "content-type": file.contentType,
      "x-vorton-variant": build.config.variant, "x-vorton-build-id": build.config.buildId } });
  };
  const context = vm.createContext({
    self: { location: { origin }, registration: { installing }, addEventListener(type, handler) { handlers.set(type, handler); },
      async skipWaiting() { activationRequests++; requested(); await activationGate; },
      clients: { async get() { return { url: sourceUrl }; } } },
    crypto: webcrypto, caches: storage, fetch: network, URL, Response, Headers, TextEncoder, TextDecoder, Uint8Array,
    AbortController, setTimeout, clearTimeout,
  });
  vm.runInContext(renderWorker(build.config), context);
  return {
    storage, requests, origin, firstActivationRequest,
    async background() { await Promise.all(background.splice(0)); },
    get activationRequests() { return activationRequests; },
    stateChanged(state) { installing.state = state; installing.dispatchEvent(new Event("statechange")); },
    async lifecycle(type) {
      let pending; handlers.get(type)({ waitUntil(value) { pending = value; } });
      await pending;
    },
    async request(pathname, overrides = {}) {
      let response;
      handlers.get("fetch")({ request: { url: origin + pathname, method: "GET", mode: "cors", cache: "default", ...overrides },
        waitUntil(value) { background.push(value); },
        respondWith(value) { response = value; } });
      return response ? await response : null;
    },
    async message(type, overrides = {}) {
      let pending, result;
      handlers.get("message")({ source: { id: "synthetic-client" },
        data: { contract: "vorton.offline-control.v1", type, requestId: "fixture-request", installationId: "00000000-0000-4000-8000-000000000001", variant: build.config.variant, ...overrides },
        ports: [{ postMessage(value) { result = value; } }], waitUntil(value) { if (!pending) pending = value; else background.push(value); } });
      await pending;
      return result;
    },
  };
}

test("startup verifies boot files while offline extras download separately and optional failures remain visible", async () => {
  const build = buildFixture("portable", "staged", true);
  let unavailable = true;
  const worker = simulatedWorker(build, undefined, undefined, undefined, url =>
    unavailable && url.endsWith(".woff2") ? Promise.resolve(new Response("unavailable", { status: 503 })) : undefined);
  await worker.lifecycle("install");
  await worker.lifecycle("activate");
  assert.ok(!worker.requests.some(url => /lazy-|\.woff2/.test(url)), "Extras must not extend installation");
  let status = await worker.message("STATUS");
  assert.equal(status.codeReady, true);
  assert.equal(status.ready, false);
  assert.equal(status.pendingAssets, 3);
  assert.equal((await worker.message("PREPARE_OFFLINE")).type, "PREPARING");
  await worker.background();
  status = await worker.message("STATUS");
  assert.equal(status.ready, true, "All mandatory executable code is saved");
  assert.equal(status.codeReady, true);
  assert.equal(status.optionalPending, 1);
  assert.match(status.error, /Retry when connected/);
  unavailable = false;
  await worker.message("PREPARE_OFFLINE"); await worker.background();
  status = await worker.message("STATUS");
  assert.equal(status.pendingAssets, 0);
  assert.equal(status.error, undefined);
});

test("a missing boot dependency prevents staged installation", async () => {
  const build = buildFixture("portable", "staged", true);
  const worker = simulatedWorker(build, undefined, undefined, undefined, url =>
    url.includes("/app-") ? Promise.resolve(new Response("unavailable", { status: 503 })) : undefined);
  await assert.rejects(worker.lifecycle("install"));
  assert.equal(worker.activationRequests, 0);
  assert.equal((await worker.message("STATUS")).codeReady, false);
});

test("preparation repairs evicted and corrupt boot assets instead of reporting false readiness", async () => {
  const build = buildFixture("portable", "repair", true), worker = simulatedWorker(build);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  const cache = await worker.storage.open(`vorton-code-v1:portable:${build.config.buildId}`);
  await cache.delete(worker.origin + "/offline-shell.html");
  await cache.put(worker.origin + "/demo-assets/app-repair.js", new Response("corrupt", { headers: { "content-type": "text/javascript" } }));
  let status = await worker.message("STATUS");
  assert.equal(status.codeReady, false);
  assert.equal(status.ready, false);
  assert.equal(status.supportsPreparation, true);
  await worker.message("PREPARE_OFFLINE"); await worker.background();
  status = await worker.message("STATUS");
  assert.equal(status.codeReady, true);
  assert.equal(status.ready, true);
  assert.equal(await (await cache.match(worker.origin + "/demo-assets/app-repair.js")).text(), build.files.get("/demo-assets/app-repair.js").body);
});

test("verified worker requests activation again at installed state without treating the request as activation", async () => {
  const worker = simulatedWorker(buildFixture());
  await worker.lifecycle("install");
  const before = worker.activationRequests;
  worker.stateChanged("installed");
  assert.equal(worker.activationRequests, before + 1, "Installed transition must request activation for historical clients");
  worker.stateChanged("installed");
  assert.equal(worker.activationRequests, before + 1, "The transition handler removes itself after requesting activation");
});

for (const cached of [false, true]) test(`${cached ? "Cached" : "Fresh"} installation retains the activation request without asserting completed activation`, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const build = buildFixture(), storage = memoryCaches();
  if (cached) { const prior = simulatedWorker(build, storage); await prior.lifecycle("install"); await prior.lifecycle("activate"); }
  const worker = simulatedWorker(build, storage, "http://fixture.test/lastresort/bridge", undefined, undefined, gate);
  let timer, finished = false;
  const installation = worker.lifecycle("install").then(() => { finished = true; });
  void installation.catch(() => {});
  try {
    await Promise.race([
      worker.firstActivationRequest,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Installation did not request activation")), 1000); }),
    ]);
    assert.equal(finished, false, "The install lifetime retains the unsettled skip request");
    assert.equal((await worker.message("ACTIVATE")).type, "ACTIVATED");
    assert.equal(finished, false, "A protocol acknowledgement is not lifecycle completion");
  } finally { release(); clearTimeout(timer); await installation; }
});

test("worker accepts recovery control messages without caching the recovery route", async () => {
  const build = buildFixture("private");
  const worker = simulatedWorker(build, memoryCaches(), "http://fixture.test/aubos/update-forge?__vorton_entry=1");
  await worker.lifecycle("install");
  assert.equal((await worker.message("ACTIVATE")).type, "ACTIVATED");
  assert.equal(await worker.request("/aubos/update-forge", { mode: "navigate" }), null);
});

test("worker verifies saved code after termination, paints cached navigation and excludes APIs", async () => {
  const build = buildFixture(), worker = simulatedWorker(build);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  const restarted = simulatedWorker(build, worker.storage);
  assert.equal((await restarted.message("STATUS")).ready, true);
  const shell = await restarted.request("/lastresort/bridge?view=fixture", { mode: "navigate" });
  assert.equal(await shell.text(), build.files.get("/offline-shell.html").body);
  assert.deepEqual(restarted.requests, [restarted.origin + "/offline-assets.json"]);
  const codeUrl = build.inventory.entries.find(e => e.url.endsWith(".js")).url;
  assert.equal(await (await restarted.request(codeUrl)).text(), build.files.get(codeUrl).body);
  for (const route of ["/api/session", "/api/lastresort/state", "/dashboard-manifest.json", "/server/rolodex.mjs", "/unknown/bridge", "/aubos/bridge"])
    assert.equal(await restarted.request(route, { mode: "navigate" }), null, route);
  assert.equal(await restarted.request(codeUrl, { method: "POST" }), null);
  assert.equal(await (await restarted.request(codeUrl, { cache: "reload" })).text(), build.files.get(codeUrl).body);
  assert.equal(await restarted.request(codeUrl, { cache: "no-store" }), null);
  assert.equal(await restarted.request(codeUrl, { url: "https://foreign.example" + codeUrl }), null);
  const cache = await worker.storage.open(`vorton-code-v1:portable:${build.config.buildId}`);
  await cache.put(worker.origin + codeUrl, new Response("corrupt", { headers: { "content-type": "text/javascript" } }));
  assert.equal(await (await restarted.request(codeUrl)).text(), build.files.get(codeUrl).body, "Corrupt cache must use network, never invalid bytes");
  assert.equal(restarted.requests.length, 2);
});

test("offline reload subresources use verified code instead of bypassing the worker cache", async () => {
  const build = buildFixture(), worker = simulatedWorker(build);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  const offline = simulatedWorker(build, worker.storage, undefined, undefined, () => Promise.reject(Error("Offline")));
  const codeUrl = build.inventory.entries.find(entry => entry.url.endsWith(".js")).url;
  assert.equal(await (await offline.request(codeUrl, { cache: "reload" })).text(), build.files.get(codeUrl).body);
  assert.equal(offline.requests.length, 0);
});

test("navigation paints cached HTML but explicit reload fetches current HTML with an outage fallback", async () => {
  const build = buildFixture();
  let mode = "online";
  const worker = simulatedWorker(build, memoryCaches(), undefined, undefined, (url, options) => {
    if (new URL(url).pathname !== "/lastresort/bridge") return;
    if (mode === "offline") return Promise.reject(new Error("Disconnected"));
    if (mode === "unavailable") return new Response("Unavailable", { status: 503 });
    if (mode === "denied") return new Response("Denied", { status: 403 });
    return new Response("newer live document");
  });
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  assert.equal(await (await worker.request("/lastresort/bridge", { mode: "navigate", cache: "default" })).text(), build.files.get("/offline-shell.html").body);
  for (const cache of ["reload", "no-cache", "no-store"])
    assert.equal(await (await worker.request("/lastresort/bridge", { mode: "navigate", cache })).text(), "newer live document");
  assert.equal(await (await worker.request("/lastresort/bridge?__vorton_reload=1", { mode: "navigate", cache: "default" })).text(), "newer live document");
  for (mode of ["offline", "unavailable"])
    assert.equal(await (await worker.request("/lastresort/bridge", { mode: "navigate", cache: "reload" })).text(), build.files.get("/offline-shell.html").body);
  mode = "denied";
  assert.equal((await worker.request("/lastresort/bridge", { mode: "navigate", cache: "reload" })).status, 403);
  // API requests, including their access decisions, never enter the code cache.
  assert.equal(await worker.request("/api/session", { mode: "navigate" }), null);
});

test("worker install rejects digest/type/size failures and leaves prior complete build available", async () => {
  const first = buildFixture(), active = simulatedWorker(first);
  await active.lifecycle("install"); await active.lifecycle("activate");
  const second = buildFixture("portable", "two");
  const codeUrl = second.inventory.entries.find(e => e.url.endsWith(".js")).url;
  second.files.set(codeUrl, { ...second.files.get(codeUrl), body: "bad bytes" });
  const rejected = simulatedWorker(second, active.storage);
  await assert.rejects(rejected.lifecycle("install"), /digest mismatch/);
  assert.equal(rejected.activationRequests, 0, "An incomplete build must never request activation");
  assert.equal((await active.message("STATUS")).ready, true);
  assert.equal((await active.storage.keys()).includes(`vorton-code-v1:portable:${second.config.buildId}`), false);
  for (const failure of ["inventory", "type", "size"]) {
    const build = buildFixture("portable", failure);
    if (failure === "inventory") build.files.get("/offline-assets.json").body += " ";
    else {
      const url = build.inventory.entries.find(e => e.url.endsWith(".js")).url;
      if (failure === "type") build.files.get(url).contentType = "application/json";
      else build.files.get(url).body += "X";
    }
    await assert.rejects(simulatedWorker(build, active.storage).lifecycle("install"));
  }
  assert.equal((await active.message("STATUS")).ready, true);
});

test("reinstall repairs an evicted asset even when the complete marker remains", async () => {
  const build = buildFixture(), worker = simulatedWorker(build);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  const cache = await worker.storage.open(`vorton-code-v1:portable:${build.config.buildId}`);
  const entry = build.inventory.entries.find(e => e.url.endsWith(".js"));
  await cache.delete(worker.origin + entry.url);
  const repair = simulatedWorker(build, worker.storage);
  await repair.lifecycle("install");
  assert.ok(await cache.match(worker.origin + entry.url), "A stale completion marker must not suppress repair");
});

test("activated worker serves an old tab's lazy code from the retained previous build when offline", async () => {
  const first = buildFixture(), active = simulatedWorker(first);
  await active.lifecycle("install"); await active.lifecycle("activate");
  let offline = false;
  const second = simulatedWorker(buildFixture("portable", "two"), active.storage, undefined, undefined,
    () => offline ? Promise.reject(new Error("Disconnected")) : undefined);
  await second.lifecycle("install"); await second.lifecycle("activate");
  offline = true;
  const url = first.inventory.entries.find(e => e.url.endsWith(".js")).url;
  assert.equal(await (await second.request(url)).text(), first.files.get(url).body);
});

test("activation requests require a complete verified installation", async () => {
  const worker = simulatedWorker(buildFixture());
  assert.equal((await worker.message("ACTIVATE")).type, "ERROR");
  await worker.lifecycle("install");
  assert.equal((await worker.message("ACTIVATE")).type, "ACTIVATED");
});

test("same-origin build variant switch cannot inherit an old private shell", async () => {
  const build = buildFixture("private"), worker = simulatedWorker(build, memoryCaches(), undefined, undefined,
    url => build.config.variant === "portable" && new URL(url).pathname === "/lastresort/bridge" ? new Response("portable network document") : undefined);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  build.config.variant = "portable";
  const response = await worker.request("/lastresort/bridge", { mode: "navigate" });
  assert.equal(await response.text(), "portable network document", "Never substitute the private cached shell");
  assert.deepEqual(worker.requests.slice(-2), [worker.origin + "/offline-assets.json", worker.origin + "/lastresort/bridge"]);
});

test("rolling back to a host without PWA controls serves its network document and assets", async () => {
  const build = buildFixture("private");
  let rolledBack = false;
  const worker = simulatedWorker(build, memoryCaches(), "http://fixture.test/aubos/bridge", () =>
    new Response(null, { status: rolledBack ? 404 : 200, headers: { "x-vorton-variant": "private" } }),
  url => rolledBack ? new Response(new URL(url).pathname.endsWith(".js") ? "rollback code" : "rollback document") : undefined);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  assert.equal(await (await worker.request("/aubos/bridge", { mode: "navigate" })).text(), build.files.get("/offline-shell.html").body);
  rolledBack = true;
  assert.equal(await (await worker.request("/aubos/bridge", { mode: "navigate" })).text(), "rollback document");
  const codeUrl = build.inventory.entries.find(entry => entry.url.endsWith(".js")).url;
  assert.equal(await (await worker.request(codeUrl)).text(), "rollback code", "The old controller must not replace rollback assets with its pinned code");
});

test("private syntactic navigation admits published goal/task/opportunity routes without admitting another workspace", async () => {
  const build = buildFixture("private"), worker = simulatedWorker(build);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  for (const route of ["/aubos/goals/synthetic-goal", "/aubos/tasks/priority", "/aubos/opportunities/selected", "/aubos/finance/runway/history"])
    assert.equal(await (await worker.request(route, { mode: "navigate" })).text(), build.files.get("/offline-shell.html").body);
  assert.equal(await worker.request("/another-organization/bridge", { mode: "navigate" }), null);
});

test("cached paint does not wait for background metadata", async () => {
  let finish;
  const build = buildFixture();
  const worker = simulatedWorker(build, memoryCaches(), "http://fixture.test/lastresort/bridge", options => {
    return new Promise(resolve => { finish = resolve; });
  }, url => new URL(url).pathname === "/lastresort/bridge" ? new Response("current online document") : undefined);
  await worker.lifecycle("install"); await worker.lifecycle("activate");
  const response = await worker.request("/lastresort/bridge", { mode: "navigate" });
  assert.equal(await response.text(), build.files.get("/offline-shell.html").body);
  assert.ok(finish, "The background check started without blocking the cached response");
  finish(new Response(null, { headers: { "x-vorton-variant": "portable" } }));
  await worker.background();
});

test("verified updates request activation and retain current/previous startup caches without claiming clients", async () => {
  const storage = memoryCaches(), builds = [];
  for (const version of ["one", "two", "three"]) {
    const build = buildFixture("portable", version); builds.push(build);
    const worker = simulatedWorker(build, storage);
    await worker.lifecycle("install"); await worker.lifecycle("activate");
    assert.equal(worker.activationRequests, 1);
    // clients.claim does not exist here: open documents must not be claimed.
    const reinstall = simulatedWorker(build, storage);
    await reinstall.lifecycle("install");
    assert.equal(reinstall.activationRequests, 1, "Same-build worker fixes must also request activation");
  }
  const keys = (await storage.keys()).filter(key => key.startsWith("vorton-code-v1:"));
  assert.equal(keys.length, 2);
  assert.ok(keys.includes(`vorton-code-v1:portable:${builds[2].config.buildId}`));
  assert.ok(keys.includes(`vorton-code-v1:portable:${builds[1].config.buildId}`));
});

test("forget messages clear only owned variant code caches and reject foreign sources/contracts", async () => {
  const build = buildFixture(), worker = simulatedWorker(build);
  await worker.lifecycle("install");
  await worker.storage.open("unrelated-cache");
  await worker.storage.open("vorton-code-v1:private:unrelated-build");
  assert.equal(await worker.message("FORGET_DEVICE", { variant: "private" }), undefined);
  assert.equal(await worker.message("FORGET_DEVICE", { contract: "foreign" }), undefined);
  const foreign = simulatedWorker(build, worker.storage, "https://foreign.example/lastresort/bridge");
  assert.equal(await foreign.message("FORGET_DEVICE"), undefined);
  assert.equal((await worker.message("STATUS")).ready, true);
  const reply = await worker.message("FORGET_DEVICE");
  assert.equal(reply.type, "FORGOTTEN");
  assert.equal(reply.installationId, "00000000-0000-4000-8000-000000000001");
  assert.equal((await worker.message("STATUS")).ready, false);
  assert.deepEqual((await worker.storage.keys()).sort(), ["unrelated-cache", "vorton-code-v1:private:unrelated-build", "vorton-pwa-control-v1:portable"].sort());
  await worker.request("/lastresort/bridge", { mode: "navigate" });
  assert.equal(worker.requests.at(-1), worker.origin + "/lastresort/bridge", "Online navigation still reaches the server after forgetting offline code");
});

test("forget tombstone prevents a pending installer from republishing a complete cache", async () => {
  const active = simulatedWorker(buildFixture());
  await active.lifecycle("install"); await active.lifecycle("activate");
  const build = buildFixture("portable", "pending");
  let release, reached;
  const started = new Promise(resolve => { reached = resolve; });
  const incoming = simulatedWorker(build, active.storage, "http://fixture.test/lastresort/bridge", undefined, url => {
    if (!url.endsWith(".js")) return;
    reached();
    return new Promise(resolve => { release = () => resolve(new Response(build.files.get(new URL(url).pathname).body,
      { headers: { "content-type": "text/javascript" } })); });
  });
  const installation = incoming.lifecycle("install");
  await started;
  assert.equal((await active.message("FORGET_DEVICE")).type, "FORGOTTEN");
  release();
  await assert.rejects(installation, /forgotten/);
  assert.equal((await active.storage.keys()).some(key => key.startsWith("vorton-code-v1:portable:")), false);
});

test("real browser updates with open tabs, preserves drafts, stays offline and acknowledges scoped forget", {
  skip: !process.env.VORTON_PWA_BROWSER && process.env.VORTON_PWA_ENGINE !== "webkit",
}, async t => {
  const { chromium, webkit } = await import("playwright-core");
  const { base, dist, config } = await hostFixture(t);
  const engine = process.env.VORTON_PWA_ENGINE === "webkit" ? webkit : chromium;
  const browser = await engine.launch({ ...(engine === chromium ? { executablePath: process.env.VORTON_PWA_BROWSER, args: ["--no-sandbox"] } : {}), headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto(base + "/lastresort/bridge");
  const session = await page.evaluate(async () => (await fetch("/api/session", { cache: "no-store" })).json());
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    if (registration.active?.state === "activated") return;
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    await new Promise((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        if (worker.state === "redundant") reject(new Error("Synthetic worker install failed"));
      });
    });
  });
  await page.goto(base + "/lastresort/bridge");
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  const message = async (type, installationId = session.installationId) => page.evaluate(async ({ type, installationId }) => {
    const channel = new MessageChannel();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker ACK timeout")), 5000);
      channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data); };
      navigator.serviceWorker.controller.postMessage({ contract: "vorton.offline-control.v1", type,
        requestId: "browser-fixture", variant: "portable", installationId }, [channel.port2]);
    });
  }, { type, installationId });
  assert.equal((await message("STATUS")).ready, true);
  await context.setOffline(true);
  await page.goto(base + "/lastresort/forge/goals");
  assert.equal(await page.evaluate(() => globalThis.fixture), "one");
  assert.equal(await page.evaluate(async () => { try { await fetch("/api/session"); return true; } catch { return false; } }), false);
  const unknown = await context.newPage();
  await assert.rejects(unknown.goto(base + "/unknown/bridge"));
  await unknown.close();
  await context.setOffline(false);
  const next = buildFixture("portable", "two");
  await page.evaluate(() => { const input = document.createElement("input"); input.id = "draft"; input.value = "unsaved draft"; document.body.append(input); });
  for (const [url, file] of next.files) {
    const filename = path.join(dist, url === "/offline-shell.html" ? "index.html" : url.slice(1));
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, file.body);
  }
  await page.evaluate(async () => {
    const changed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Verified update activation timeout")), 15000);
      navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    await (await navigator.serviceWorker.getRegistration()).update();
    await changed;
  });
  assert.equal((await message("STATUS")).buildId, next.config.buildId);
  assert.equal(await page.evaluate(() => globalThis.fixture), "one", "Activation must not reload an open document");
  assert.equal(await page.inputValue("#draft"), "unsaved draft");
  const second = await context.newPage();
  await second.goto(base + "/lastresort/tools");
  assert.equal(await second.evaluate(() => globalThis.fixture), "two", "New tabs use the verified update while the old document stays open");
  await page.close(); await second.close();
  const reopened = await context.newPage();
  await reopened.goto(base + "/lastresort/bridge");
  await reopened.waitForFunction(() => globalThis.fixture === "two");
  const forgotten = await reopened.evaluate(async installationId => {
    const channel = new MessageChannel();
    const result = new Promise(resolve => { channel.port1.onmessage = event => resolve(event.data); });
    navigator.serviceWorker.controller.postMessage({ contract: "vorton.offline-control.v1", type: "FORGET_DEVICE",
      requestId: "browser-forget", variant: "portable", installationId }, [channel.port2]);
    return result;
  }, session.installationId);
  assert.equal(forgotten.type, "FORGOTTEN");
  assert.equal((await reopened.evaluate(() => caches.keys())).some(name => name.startsWith("vorton-code-v1:portable:")), false);
  await context.close();
});
