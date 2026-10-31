import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { chromium, webkit } from "playwright-core";
import { createCoreServer } from "../server/core-http.mjs";
import { Store } from "../server/store.mjs";

test("phone editors retain twenty offline tasks and recover an uncertain local capture without duplication", {
  skip: !process.env.OFFLINE_BROWSER && process.env.OFFLINE_ENGINE !== "webkit", timeout: 120000,
}, async t => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/offline-editors-test-"));
  const dist = path.join(root, "dist");
  let browser, app, page, passed = false;
  let holdSync = false, releaseSync = () => {}, firstSync = () => {};
  let failServerStorage = false, captureVerificationBodies = false;
  const verificationBodies = [];
  const held = new Promise(resolve => { releaseSync = resolve; });
  const sending = new Promise(resolve => { firstSync = resolve; });
  const pageErrors = [], navigationTrace = [];
  const engine = process.env.OFFLINE_ENGINE === "webkit" ? webkit : chromium;
  // Playwright issue42775: WebKit offline emulation rejects even literal
  // service-worker responses. A stopped origin tests real cache fallback.
  const stoppedOrigin = engine === webkit && process.env.OFFLINE_NETWORK_MODE !== "emulated";
  t.diagnostic(`Network outage: ${stoppedOrigin ? "isolated origin stopped" : "browser offline emulation"}`);
  const options = { ...(engine === chromium ? { executablePath: process.env.OFFLINE_BROWSER } : {}),
    headless: true, viewport: { width: 390, height: 844 }, reducedMotion: "reduce", acceptDownloads: true, downloadsPath: path.join(root, "downloads") };
  try {
    await build({ configFile: path.resolve("vite.config.js"), logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
    app = createCoreServer({ root, dist, port: 0 });
    const handler = app.server.listeners("request")[0];
    app.server.removeListener("request", handler);
    app.server.on("request", (request, response) => {
      if (captureVerificationBodies && request.method === "POST" && request.url === "/api/lastresort/sync") {
        const chunks = [], index = verificationBodies.push(undefined) - 1, nativePush = request.push;
        // Copy incoming bytes without putting the stream into flowing mode
        // before the actual async handler attaches its body parser.
        request.push = function(chunk, ...args) { if (chunk !== null) chunks.push(Buffer.from(chunk)); return nativePush.call(this, chunk, ...args); };
        request.on("end", () => { verificationBodies[index] = Buffer.concat(chunks).toString("utf8"); request.push = nativePush; });
        if (failServerStorage) {
          request.on("end", () => { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ code: "storage-corrupt", error: "Synthetic server storage needs verification" })); });
          request.resume();
          return;
        }
      }
      if (holdSync && request.method === "POST" && request.url === "/api/lastresort/sync") {
        firstSync(); void held.then(() => handler.call(app.server, request, response));
      } else void handler.call(app.server, request, response);
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const port = app.server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    app.hosts.add(new URL(origin).host); app.allowed.add(origin);
    const profile = path.join(root, "browser");
    browser = await engine.launchPersistentContext(profile, options);
    // Simulate a worker committing its transaction, then losing the reply.
    // Observe before the client's onmessage handler, without altering SQL.
    const trackDevice = () => {
      window.testDocumentId = crypto.randomUUID();
      let sequence = 9000000;
      window.storageRPC = (action, payload = {}) => new Promise((resolve, reject) => {
        const worker = window.testStorageWorker, requestId = ++sequence;
        const timer = setTimeout(() => { worker.removeEventListener("message", answer); reject(Error("Fixture storage request timed out")); }, 3000);
        const answer = event => {
          if (event.data?.requestId !== requestId) return;
          clearTimeout(timer); worker.removeEventListener("message", answer);
          if (event.data.ok) resolve(event.data.result); else reject(Error(event.data.error));
        };
        worker.addEventListener("message", answer);
        worker.postMessage({ ...window.testDeviceContext, ...payload, action, requestId });
      });
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          window.testStorageWorker = this;
          this.addEventListener("message", event => {
            if (!window.dropNextLocalConfirmation || event.data?.result?.status !== "locally-saved") return;
            window.dropNextLocalConfirmation = false;
            event.stopImmediatePropagation();
            window.interruptLocalConfirmation = () => this.dispatchEvent(new ErrorEvent("error", { message: "Synthetic lost local confirmation" }));
          });
        }
        postMessage(message, ...args) {
          if (message.deviceEpoch) window.testDeviceContext = { scope: message.scope, deviceEpoch: message.deviceEpoch };
          return super.postMessage(message, ...args);
        }
      };
    };
    await browser.addInitScript(trackDevice);
    page = await browser.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => navigationTrace.push({ type: "request", url: request.url(), resource: request.resourceType(), navigation: request.isNavigationRequest() }));
    page.on("requestfailed", request => navigationTrace.push({ type: "failed", url: request.url(), error: request.failure()?.errorText }));
    page.on("response", response => navigationTrace.push({ type: "response", url: response.url(), status: response.status() }));
    page.on("framenavigated", frame => { if (!frame.parentFrame()) navigationTrace.push({ type: "commit", url: frame.url() }); });
    await page.goto(origin + "/lastresort/forge/tasks", { waitUntil: "domcontentloaded" });
    const create = async title => {
      await page.getByRole("button", { name: "New task", exact: true }).click();
      await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
      await page.getByRole("button", { name: "Save task", exact: true }).click();
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
    };
    await create("Warm storage probe");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    const boot = await page.evaluate(async () => {
      const name = (await caches.keys()).find(name => name.startsWith("vorton-code-v1:portable:"));
      if (!name) throw Error("No saved application cache");
      const cache = await caches.open(name);
      const marker = await (await cache.match(location.origin + "/__vorton_pwa__/complete"))?.json();
      const inventory = await (await cache.match(location.origin + "/offline-assets.json"))?.json();
      const entries = [];
      for (const entry of inventory?.entries.filter(entry => entry.role === "boot") ?? []) {
        const response = await cache.match(location.origin + entry.url);
        const bytes = response && await response.arrayBuffer();
        const hash = bytes && [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        entries.push({ url: entry.url, readable: hash === entry.sha256 });
      }
      return { marker, buildId: inventory?.buildId, entries, controller: navigator.serviceWorker.controller?.scriptURL };
    });
    assert.ok(boot.controller && boot.marker?.buildId === boot.buildId && boot.entries.length > 0 && boot.entries.every(entry => entry.readable));
    await writeFile(path.join(root, "boot.json"), JSON.stringify(boot, null, 2));
    const offlineNavigation = async () => {
      const before = await page.evaluate(() => window.testDocumentId);
      navigationTrace.push({ type: "offline-navigation", before, mode: process.env.OFFLINE_NAVIGATION ?? "reload" });
      if (process.env.OFFLINE_NAVIGATION === "marked") await page.goto(origin + "/lastresort/forge/tasks?__vorton_reload=1", { waitUntil: "domcontentloaded" });
      else if (process.env.OFFLINE_NAVIGATION === "ordinary") await page.goto(origin + "/lastresort/forge/tasks?offline_probe=1", { waitUntil: "domcontentloaded" });
      else await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(before => Boolean(window.testDocumentId && window.testDocumentId !== before), before);
    };
    if (stoppedOrigin) {
      app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
      const negative = await browser.newPage();
      await assert.rejects(negative.goto(origin + "/not-an-offline-route", { waitUntil: "domcontentloaded" }));
      await negative.close();
    } else await browser.setOffline(true);
    for (let index = 1; index <= 20; index++) await create(`Phone offline task ${index}`);
    assert.equal(await page.getByText(/^Phone offline task \d+$/, { exact: true }).count(), 20);
    await page.locator(".connection-status-button").click();
    const queue = page.getByRole("list", { name: "Pending local changes" });
    assert.equal(await queue.getByRole("listitem").filter({ hasText: /Phone offline task \d+\b/ }).count(), 20);
    for (let index = 1; index <= 20; index++) {
      const row = queue.getByRole("listitem").filter({ has: page.getByText(`Phone offline task ${index}`, { exact: true }) });
      assert.equal(await row.getByText("Create task", { exact: true }).count(), 1);
      assert.equal(await row.getByText(/Saved on this device/).count(), 1);
    }
    await queue.locator("strong").filter({ hasText: /^Phone offline task 20$/ }).scrollIntoViewIfNeeded();
    assert.ok(await queue.evaluate(list => list.scrollTop > 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.KEEP_OFFLINE_EVIDENCE) {
      await queue.evaluate(list => { list.scrollTop = 0; });
      await page.screenshot({ path: path.join(root, "queue-phone.png") });
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".connection-status-button").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".connection-status-button").evaluate(button => document.activeElement === button), true);
    await page.getByRole("link", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Phone goal");
    await page.getByRole("button", { name: "Save goal", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    if (!await page.getByRole("button", { name: "Edit goal", exact: true }).isVisible()) await page.getByRole("button").filter({ hasText: "Phone goal" }).first().click();
    await page.getByRole("button", { name: "Edit goal", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Edited phone goal");
    await page.getByRole("button", { name: "Save goal", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Ideas", exact: true }).click();
    await page.getByRole("button", { name: "New idea", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Phone idea");
    await page.getByRole("dialog").getByRole("button", { name: "Save idea", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Phone idea", exact: true }).click();
    await page.getByRole("button", { name: "Edit idea", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Edited phone idea");
    await page.getByRole("dialog").getByRole("button", { name: "Save idea", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await offlineNavigation();
    await page.getByText("Phone offline task 20", { exact: true }).waitFor();
    assert.equal(await page.getByText(/^Phone offline task \d+$/, { exact: true }).count(), 20);

    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Original interrupted capture");
    await page.evaluate(() => { window.dropNextLocalConfirmation = true; });
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.waitForFunction(() => typeof window.interruptLocalConfirmation === "function");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Newer retained capture");
    await page.evaluate(() => window.interruptLocalConfirmation());
    await page.getByText(/Retry this saved attempt/).waitFor();
    await offlineNavigation();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await title.waitFor();
    assert.equal(await title.inputValue(), "Newer retained capture");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.getByText("The submitted version was saved. Newer edits remain a local draft.", { exact: true }).waitFor();
    assert.equal(await title.inputValue(), "Newer retained capture");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    assert.equal(await page.getByText("Newer retained capture", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Original interrupted capture", { exact: true }).count(), 0);
    await browser.close();
    browser = await engine.launchPersistentContext(profile, { ...options, offline: !stoppedOrigin });
    await browser.addInitScript(trackDevice);
    page = await browser.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(origin + "/lastresort/forge/tasks", { waitUntil: "domcontentloaded" });
    await page.getByText("Newer retained capture", { exact: true }).waitFor();
    assert.equal(await page.getByText(/^Phone offline task \d+$/, { exact: true }).count(), 20);
    holdSync = true;
    if (stoppedOrigin) {
      await new Promise(resolve => app.server.listen(port, "127.0.0.1", resolve));
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    } else await browser.setOffline(false);
    let sendingTimer;
    try { await Promise.race([sending, new Promise((_, reject) => { sendingTimer = setTimeout(() => reject(Error("No synchronization request reached the restored isolated server")), 15000); })]); }
    finally { clearTimeout(sendingTimer); }
    await page.locator(".connection-status-button").click();
    const reconnectQueue = page.getByRole("list", { name: "Pending local changes" });
    assert.equal(await reconnectQueue.getByRole("listitem").filter({ hasText: /Phone offline task \d+\b/ }).count(), 20);
    await reconnectQueue.getByText("Sending. Server acceptance is not confirmed.", { exact: true }).waitFor();
    releaseSync();
    const store = new Store(root), deadline = Date.now() + 30000;
    let state;
    do {
      state = await store.read("LastResort");
      if (state.tasks.length === 22 && state.tasks.some(task => task.title === "Newer retained capture")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(state.tasks.length, 22);
    assert.equal(state.events.length, 27);
    assert.equal(state.goals[0].title, "Edited phone goal");
    assert.equal(state.ideas[0].title, "Edited phone idea");
    assert.equal(state.tasks.filter(task => task.title === "Newer retained capture").length, 1);
    await page.getByText("All local changes have been accepted by the server.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Accepted uncertain capture");
    await page.evaluate(() => { window.dropNextLocalConfirmation = true; });
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.waitForFunction(() => typeof window.interruptLocalConfirmation === "function");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Retained after read clear");
    await page.evaluate(() => window.interruptLocalConfirmation());
    await page.getByText(/Retry this saved attempt/).waitFor();
    await page.getByRole("button", { name: "Close editor", exact: true }).click();
    // A lost local confirmation pauses delivery until the owner rechecks
    // device storage. Foreground events cannot turn uncertainty into a retry.
    await page.locator(".connection-status-button").click();
    await page.getByRole("button", { name: "Retry device storage", exact: true }).click();
    await page.locator("#connection-status-panel").getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    const acceptedDeadline = Date.now() + 15000;
    do {
      state = await store.read("LastResort");
      if (state.tasks.some(task => task.title === "Accepted uncertain capture")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < acceptedDeadline);
    assert.equal(state.tasks.length, 23);
    await page.locator(".connection-status-button").click();
    await page.getByText("All local changes have been accepted by the server.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByLabel("Switch installation", { exact: true }).click();
    await page.getByRole("button", { name: "Offline and device storage", exact: true }).click();
    const storage = page.getByRole("dialog", { name: "Offline and device storage", exact: true });
    await storage.getByRole("button", { name: "Forget this installation", exact: true }).click();
    const exporting = page.waitForEvent("download");
    await storage.getByRole("button", { name: "Export local changes", exact: true }).click();
    const exported = JSON.parse(await readFile(await (await exporting).path(), "utf8"));
    assert.ok(exported.drafts.some(draft => draft.fields.title === "Retained after read clear"));
    assert.equal(exported.drafts.find(draft => draft.fields.title === "Retained after read clear").baseline.syncGeneration, state.syncGeneration);
    assert.ok(exported.data.outbox.some(row => row.status === "accepted" && JSON.parse(row.operation).value?.title === "Accepted uncertain capture"));
    await storage.getByRole("button", { name: "Cancel", exact: true }).click();
    await storage.getByRole("button", { name: "Clear saved read copies", exact: true }).click();
    await storage.getByText("Saved read copies were cleared. Local drafts and save confirmations remain on this device.", { exact: true }).waitFor();
    await storage.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    await storage.getByRole("button", { name: "Close", exact: true }).click();
    // A historical draft can have the same numeric revision as restored data.
    // Change only its retained generation while no editor is mounted.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("vorton-offline-v1", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("drafts", "readwrite"), cursor = tx.objectStore("drafts").openCursor();
        let changed = false;
        cursor.onsuccess = () => { const row = cursor.result; if (!row) return;
          if (row.value.fields.title === "Retained after read clear") { row.update({ ...row.value, baseline: { ...row.value.baseline, syncGeneration: crypto.randomUUID() } }); changed = true; }
          row.continue();
        };
        tx.oncomplete = () => { db.close(); changed ? resolve() : reject(Error("Retained draft was missing")); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "Retained after read clear");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.getByText("The submitted version was saved. Newer edits remain a local draft.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.getByText(/Server history changed since this draft began/).first().waitFor();
    assert.equal((await store.read("LastResort")).events.length, 28);
    assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "Retained after read clear");
    await page.getByRole("button", { name: "Review current records", exact: true }).click();
    await page.getByText("Current record", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Use reviewed revision for this draft", exact: true }).click();
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await page.locator(".connection-status-button").click();
    await page.getByText("All local changes have been accepted by the server.", { exact: true }).waitFor();
    state = await store.read("LastResort");
    assert.equal(state.tasks.length, 23); assert.equal(state.events.length, 29);
    assert.equal(state.tasks.filter(task => task.title === "Retained after read clear").length, 1);
    const warmId = state.tasks.find(task => task.title === "Warm storage probe").id;
    let currentTitle = "Warm storage probe";
    for (const choice of ["local", "server"]) {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: currentTitle, exact: true }).click();
      if (stoppedOrigin) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
      else await browser.setOffline(true);
      const localTitle = choice === "local" ? "Retained local conflict" : "Discarded local conflict";
      const remoteTitle = choice === "local" ? "Independent server edit" : "Kept server edit";
      await page.getByRole("textbox", { name: "Title", exact: true }).fill(localTitle);
      await page.getByRole("button", { name: "Save task", exact: true }).click();
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
      state = await store.read("LastResort");
      await store.command("LastResort", { requestId: crypto.randomUUID(), expectedRevision: state.revision,
        action: "task.update", payload: { id: warmId, fields: { title: remoteTitle } } });
      if (stoppedOrigin) {
        await new Promise(resolve => app.server.listen(port, "127.0.0.1", resolve));
        await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      } else await browser.setOffline(false);
      await page.locator(".connection-status-button").click();
      const conflict = page.getByRole("list", { name: "Pending local changes" }).getByRole("listitem").filter({ has: page.getByText(localTitle, { exact: true }) });
      await conflict.getByText("Conflict. Your local version is saved.", { exact: true }).waitFor();
      await conflict.getByText("Review change", { exact: true }).click();
      await conflict.getByText(remoteTitle, { exact: true }).waitFor();
      if (choice === "local") await conflict.getByRole("button", { name: "Submit my saved version", exact: true }).click();
      else {
        await conflict.getByRole("button", { name: "Use server version", exact: true }).click();
        // Another local producer commits after the displayed comparison. It
        // uses the real worker, SQL transaction and device epoch checks.
        await page.evaluate(async id => {
          const workspace = await window.storageRPC("workspace");
          const row = workspace.records.find(row => row.kind === "task" && row.id === id);
          const prior = JSON.parse(row.body), operationId = crypto.randomUUID(), title = "Unreviewed concurrent local text";
          await window.storageRPC("enqueue", { operationId, kind: "task", id, title,
            operation: { operationId, kind: "task", id, action: "update", expectedRevision: row.revision, value: { title } },
            record: { ...prior, title, version: prior.version + 1 }, baselineVersion: prior.version });
        }, warmId);
        await conflict.getByRole("button", { name: "Confirm server version", exact: true }).click();
        await page.getByRole("alert").getByText(/local version changed while you were reviewing/).waitFor();
        assert.equal(await conflict.getByRole("button", { name: "Confirm server version", exact: true }).isDisabled(), true);
        await conflict.getByText("Unreviewed concurrent local text", { exact: true }).waitFor();
        await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
        await conflict.getByRole("button", { name: "Use server version", exact: true }).click();
        await conflict.getByRole("button", { name: "Confirm server version", exact: true }).click();
      }
      await page.getByText("No pending local changes. Reviewed resolutions remain in recovery history.", { exact: true }).waitFor();
      currentTitle = choice === "local" ? localTitle : remoteTitle;
      state = await store.read("LastResort");
      assert.equal(state.tasks.find(task => task.id === warmId).title, currentTitle);
    }
    assert.equal(state.tasks.length, 23); assert.equal(state.events.length, 32);
    // A server-storage recovery probe is separately owned. Session/GET success
    // must not become normal admission or release its pending operation.
    failServerStorage = true; captureVerificationBodies = true;
    await create("Server storage verification task");
    await page.locator(".connection-status-button").click();
    await page.getByRole("button", { name: "Verify server storage", exact: true }).waitFor();
    const originalAttempt = await page.evaluate(async () => (await window.storageRPC("workspace")).outbox.find(row => row.title === "Server storage verification task"));
    assert.equal(verificationBodies.length, 1);
    failServerStorage = false;
    await page.getByRole("button", { name: "Verify server storage", exact: true }).click();
    await page.getByText("Read-only verification completed. Saved changes have not been sent.", { exact: true }).waitFor();
    await page.evaluate(async () => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("pageshow")); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const retainedAttempt = await page.evaluate(async () => (await window.storageRPC("workspace")).outbox.find(row => row.title === "Server storage verification task"));
    assert.equal(retainedAttempt.operation_id, originalAttempt.operation_id);
    assert.equal(retainedAttempt.operation, originalAttempt.operation);
    assert.equal(retainedAttempt.generation, originalAttempt.generation);
    assert.equal(verificationBodies.length, 1, "read-only verification and reactive callbacks cannot send");
    state = await store.read("LastResort"); assert.equal(state.tasks.length, 23); assert.equal(state.events.length, 32);
    await page.getByRole("button", { name: "Test connection and retry", exact: true }).click();
    const verifiedDeliveryDeadline = Date.now() + 15000;
    do { state = await store.read("LastResort"); if (state.tasks.some(task => task.title === "Server storage verification task")) break; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < verifiedDeliveryDeadline);
    assert.equal(state.tasks.length, 24); assert.equal(state.events.length, 33);
    await page.getByText("No pending local changes. Reviewed resolutions remain in recovery history.", { exact: true }).waitFor();
    const acceptedAttempt = await page.evaluate(async operationId => (await window.storageRPC("workspace")).outbox.find(row => row.operation_id === operationId), originalAttempt.operation_id);
    assert.equal(acceptedAttempt.status, "accepted"); assert.equal(acceptedAttempt.operation, originalAttempt.operation); assert.equal(acceptedAttempt.generation, originalAttempt.generation);
    assert.equal(verificationBodies.length, 2); assert.equal(verificationBodies[1], verificationBodies[0]);
    assert.deepEqual(pageErrors, []);
    if (process.env.KEEP_OFFLINE_EVIDENCE) await writeFile(path.join(root, "verification.json"), JSON.stringify({
      engine: engine === webkit ? "webkit" : "chromium", browserVersion: browser.browser()?.version(),
      outage: stoppedOrigin ? "origin-stopped" : "emulated", navigation: process.env.OFFLINE_NAVIGATION ?? "reload",
      bootFilesVerified: boot.entries.length, twentySeparateQueueRows: true, scrollablePhoneQueue: true, escapeAndFocus: true,
      pendingDuringReconnect: true, interruptedCapturePreserved: true, offlineReopen: true,
      conflictKeepLocal: true, conflictUseServer: true,
      offlineGoalCreateAndEdit: true, offlineIdeaCreateAndEdit: true,
      acceptedUnconfirmedSurvivesReadClear: true,
      staleLocalResolutionRejected: true,
      recoveryExportIncludesDrafts: true,
      generationBoundDraftSurvivesReadClear: true, staleGenerationRequiresReview: true,
      originalTaskEventCountsPreserved: { tasks: 23, events: 32 }, serverStorageVerificationIsReadOnly: true,
      explicitReconnectReplaysOriginalBody: true,
      serverTasks: state.tasks.length, serverEvents: state.events.length, pageErrors,
    }, null, 2));
    passed = true;
  } catch (error) {
    await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
    const diagnostic = await page?.evaluate(async () => ({ url: location.href, online: navigator.onLine,
      controller: navigator.serviceWorker.controller?.scriptURL,
      documentId: window.testDocumentId,
      registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => ({ scope: registration.scope,
        active: registration.active?.state, waiting: registration.waiting?.state, installing: registration.installing?.state })),
      caches: await caches.keys(), content: document.body.innerText })).catch(() => null);
    await writeFile(path.join(root, "failure.json"), JSON.stringify({ error: error.message, diagnostic, pageErrors, navigationTrace }, null, 2));
    console.error(`Retained isolated failure evidence: ${root}`);
    throw error;
  } finally {
    releaseSync();
    await browser?.close();
    if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
    if (passed && !process.env.KEEP_OFFLINE_EVIDENCE) await rm(root, { recursive: true, force: true });
    else if (passed) t.diagnostic(`Retained browser evidence: ${root}`);
  }
});
