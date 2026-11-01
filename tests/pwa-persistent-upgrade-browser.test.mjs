import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { chromium, webkit } from "playwright-core";
import { createCoreServer } from "../server/core-http.mjs";

// This tests current SQLite authority across two production builds. Historical
// pre-SQLite shell delivery has a separate fixture and cannot prove this boundary.
test("persistent upgrade recovers interrupted installation without changing a pending operation", {
  skip: !process.env.OFFLINE_BROWSER && process.env.OFFLINE_ENGINE !== "webkit", timeout: 180000,
}, async t => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/persistent-upgrade-"));
  const dist = path.join(root, "served"), errors = [], posts = [], receipts = [], phases = [];
  let app, browser, page, phase = "build", blockDelivery = true, holdBoot = false;
  let bootObserved, releaseBoot;
  const bootStarted = new Promise(resolve => { bootObserved = resolve; });
  const bootReleased = new Promise(resolve => { releaseBoot = resolve; });
  const heldResponses = new Set();
  const engine = process.env.OFFLINE_ENGINE === "webkit" ? webkit : chromium;
  const options = { headless: true, viewport: { width: 390, height: 844 }, reducedMotion: "reduce",
    ...(engine === chromium ? { executablePath: process.env.OFFLINE_BROWSER } : {}) };
  const until = async predicate => {
    const deadline = Date.now() + 20000;
    do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
    throw Error(`Condition timed out during ${phase}`);
  };
  const identity = row => ({ operation_id: row.operation_id, operation: row.operation,
    generation: row.generation, dependencies: row.dependencies });
  const open = async () => {
    browser = await engine.launchPersistentContext(path.join(root, "profile"), options);
    await browser.addInitScript(() => {
      const NativeWorker = window.Worker;
      let worker, context, sequence = 9000000;
      window.Worker = class extends NativeWorker {
        postMessage(message, ...args) {
          if (message.deviceEpoch) { worker = this; context = { scope: message.scope, deviceEpoch: message.deviceEpoch }; }
          return super.postMessage(message, ...args);
        }
      };
      window.readUpgradeWorkspace = () => new Promise((resolve, reject) => {
        if (!worker || !context) return reject(Error("Storage context unavailable"));
        const target = worker, requestId = ++sequence;
        const timer = setTimeout(() => { target.removeEventListener("message", answer); reject(Error("Storage read timed out")); }, 5000);
        const answer = event => {
          if (event.data?.requestId !== requestId) return;
          clearTimeout(timer); target.removeEventListener("message", answer);
          if (event.data.ok) resolve(event.data.result); else reject(Error(event.data.error));
        };
        target.addEventListener("message", answer);
        target.postMessage({ ...context, action: "workspace", requestId });
      });
    });
    browser.on("page", target => target.on("pageerror", error => errors.push({ phase, message: error.message, stack: error.stack })));
    browser.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/lastresort/sync")
        posts.push({ phase, body: request.postDataJSON() });
    });
    page = await browser.newPage();
  };
  let original, afterUpgrade, accepted, before;
  try {
    for (const version of ["A", "B"]) await build({ configFile: path.resolve("vite.config.js"), logLevel: "silent",
      plugins: [{ name: "upgrade-fixture-version", transformIndexHtml: { order: "pre", handler: html => html.replace("<head>", `<head><meta name="fixture-release" content="${version}">`) } }],
      build: { outDir: path.join(root, version), emptyOutDir: true } });
    const inventories = await Promise.all(["A", "B"].map(version => readFile(path.join(root, version, "offline-assets.json"), "utf8").then(JSON.parse)));
    assert.notEqual(inventories[0].buildId, inventories[1].buildId);
    assert.equal(inventories[1].entries.find(entry => entry.url === "/offline-shell.html").role, "boot");
    await cp(path.join(root, "A"), dist, { recursive: true });
    app = createCoreServer({ root, dist, port: 0 });
    const handler = app.server.listeners("request")[0];
    app.server.removeListener("request", handler);
    app.server.on("request", (req, res) => {
      if (holdBoot && req.url?.split("?")[0] === "/offline-shell.html") {
        heldResponses.add(res); res.once("close", () => heldResponses.delete(res)); bootObserved();
        void bootReleased.then(() => { if (!res.destroyed) handler.call(app.server, req, res); });
        return;
      }
      if (req.method === "POST" && req.url === "/api/lastresort/sync") {
        if (blockDelivery) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Synthetic delivery outage" })); return; }
      }
      void handler.call(app.server, req, res);
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    app.hosts.add(new URL(origin).host); app.allowed.add(origin);
    const route = origin + "/lastresort/forge/tasks";
    const rendered = async version => {
      await page.waitForFunction(version => document.querySelector('meta[name="fixture-release"]')?.content === version && !!document.querySelector(".ftv"), version);
      await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    };
    const read = () => page.evaluate(() => window.readUpgradeWorkspace());
    const marker = buildId => page.evaluate(async buildId => {
      const cache = await caches.open(`vorton-code-v1:portable:${buildId}`);
      return (await cache.match(location.origin + "/__vorton_pwa__/complete"))?.json() ?? null;
    }, buildId);
    phase = "queue-in-old-build"; await open(); await page.goto(route); await rendered("A");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await until(async () => (await marker(inventories[0].buildId))?.buildId === inventories[0].buildId);
    before = await app.store.read("LastResort");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Pending through interrupted code upgrade");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await until(async () => { original = (await read()).outbox.find(row => row.status !== "accepted"); return !!original; });
    assert.ok(original.operation_id && original.generation);
    assert.equal((await app.store.read("LastResort")).tasks.length, before.tasks.length);
    phase = "hold-required-boot"; holdBoot = true;
    await cp(path.join(root, "B"), dist, { recursive: true });
    await page.evaluate(async () => { void (await navigator.serviceWorker.getRegistration()).update().catch(() => {}); });
    await Promise.race([bootStarted, new Promise((_, reject) => setTimeout(() => reject(Error("Replacement boot request was not observed")), 15000))]);
    assert.equal(await marker(inventories[1].buildId), null, "Incomplete replacement cannot publish readiness");
    const heldState = await page.evaluate(async buildId => {
      const registration = await navigator.serviceWorker.getRegistration();
      const control = await caches.open("vorton-pwa-control-v1:portable");
      const cache = await caches.open(`vorton-code-v1:portable:${buildId}`);
      const inventory = await (await cache.match(location.origin + "/offline-assets.json")).json();
      const verified = [];
      for (const entry of inventory.entries.filter(entry => entry.role === "boot")) {
        const response = await cache.match(location.origin + entry.url);
        const bytes = response && await response.arrayBuffer();
        const digest = bytes && Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        verified.push({ url: entry.url, valid: bytes?.byteLength === entry.size && digest === entry.sha256 });
      }
      return { installing: registration.installing?.state, active: registration.active?.state,
        pointer: await (await control.match(location.origin + "/__vorton_pwa__/active"))?.text(), verified };
    }, inventories[0].buildId);
    assert.equal(heldState.installing, "installing");
    assert.equal(heldState.active, "activated");
    assert.equal(heldState.pointer, `vorton-code-v1:portable:${inventories[0].buildId}`);
    assert.equal((await marker(inventories[0].buildId))?.buildId, inventories[0].buildId);
    assert.ok(heldState.verified.length > 0 && heldState.verified.every(entry => entry.valid));
    assert.ok(heldResponses.size > 0, "Required response remains incomplete at interruption");
    // The still-open old document must remain usable while installation waits.
    // Explicit reload deliberately asks the server for its new HTML, so it is
    // not a request to remain on the old build.
    await rendered("A");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Old build remains interactive");
    await page.getByRole("button", { name: "Close editor", exact: true }).click();
    assert.deepEqual(identity((await read()).outbox.find(row => row.operation_id === original.operation_id)), identity(original));
    phases.push({ phase, oldUsable: true, replacementComplete: false, heldState });
    phase = "interrupt-and-reopen";
    await browser.close(); browser = undefined;
    for (const res of heldResponses) res.destroy();
    holdBoot = false; releaseBoot();
    await open(); await page.goto(route);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await until(async () => (await marker(inventories[1].buildId))?.buildId === inventories[1].buildId);
    await page.reload(); await rendered("B");
    afterUpgrade = (await read()).outbox.find(row => row.operation_id === original.operation_id);
    assert.deepEqual(identity(afterUpgrade), identity(original));
    assert.equal((await app.store.read("LastResort")).tasks.length, before.tasks.length);
    phase = "accept-original-operation";
    page.on("response", response => {
      if (response.request().method() === "POST" && new URL(response.url()).pathname === "/api/lastresort/sync")
        void response.json().then(body => receipts.push({ status: response.status(), body })).catch(() => {});
    });
    blockDelivery = false;
    // Let ordinary bounded retry settle. Once accepted, the pending-only badge
    // can disappear, so clicking that badge would race successful delivery.
    await until(async () => { accepted = (await read()).outbox.find(row => row.operation_id === original.operation_id); return accepted?.status === "accepted"; });
    assert.deepEqual(identity(accepted), identity(original));
    await until(() => receipts.some(row => row.status === 200 && row.body.status === "accepted" && row.body.operationId === original.operation_id));
    const final = await app.store.read("LastResort");
    assert.equal(final.tasks.length, before.tasks.length + 1);
    assert.equal(final.events.length, before.events.length + 1);
    const database = await app.store.openDatabase(await app.store.directory("LastResort"));
    try {
      assert.equal(database.db.prepare("SELECT count(*) AS n FROM replica_receipts WHERE scope=? AND operation_id=?").get("LastResort", original.operation_id).n, 1);
      assert.equal(database.db.prepare("SELECT count(*) AS n FROM replica_changes WHERE scope=? AND kind='task' AND id=?").get("LastResort", accepted.record_id).n, 1);
    } finally { database.close(); }
    assert.ok(posts.length > 0);
    for (const post of posts) assert.deepEqual(post.body, posts[0].body, "Every attempt retains identical request identity and payload");
    assert.deepEqual(errors, []);
    await writeFile(path.join(root, "result.json"), JSON.stringify({ passed: true, builds: inventories.map(x => x.buildId), original, afterUpgrade, accepted, posts, receipts, phases, errors }, null, 2));
    t.diagnostic(`Evidence: ${root}`);
  } catch (error) {
    await writeFile(path.join(root, "failure.json"), JSON.stringify({ phase, error: error.stack, original, afterUpgrade, posts, receipts, phases, errors,
      rendered: await page?.locator("body").innerText().catch(() => null), shell: await page?.locator('meta[name="fixture-release"]').getAttribute("content").catch(() => null) }, null, 2));
    throw error;
  } finally {
    holdBoot = false; releaseBoot(); for (const res of heldResponses) res.destroy();
    await browser?.close(); app?.server.closeAllConnections(); await app?.close();
  }
});
