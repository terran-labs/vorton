import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "vite";
import { chromium, webkit } from "playwright-core";
import { createCoreServer } from "../server/core-http.mjs";

test("phone history review retains unsent work across adoption and reopen before explicitly creating one copy", {
  skip: !process.env.OFFLINE_BROWSER && process.env.OFFLINE_ENGINE !== "webkit", timeout: 120000,
}, async t => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/history-review-browser-"));
  let app, browser, page;
  const errors = [], trace = [];
  let phase = "initial";
  try {
    const dist = path.join(root, "dist");
    await build({ configFile: path.resolve("vite.config.js"), logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
    app = createCoreServer({ root, dist, port: 0 });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    app.hosts.add(new URL(origin).host); app.allowed.add(origin);
    const engine = process.env.OFFLINE_ENGINE === "webkit" ? webkit : chromium;
    const options = { ...(engine === chromium ? { executablePath: process.env.OFFLINE_BROWSER } : {}),
      headless: true, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" };
    const reopen = async () => {
      browser = await engine.launchPersistentContext(path.join(root, "browser"), options);
      await browser.addInitScript(({ faultMode, holdCopyRead }) => {
        const documentToken = crypto.randomUUID();
        let hidden = false, injected = false;
        window.addEventListener("pagehide", () => { hidden = true; });
        window.addEventListener("pagehide", () => window.releasePostCopyRead?.());
        const nativeFetch = window.fetch;
        window.fetch = (input, options) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
          if (url.pathname.endsWith("/changes") && url.searchParams.get("head") === "2") {
            console.debug("VORTON_TEST_FETCH", JSON.stringify({ documentToken, hidden, url: url.href, faultMode }));
            if (faultMode === "alive" && !injected) { injected = true; return Promise.reject(new TypeError("Controlled change-feed rejection in a live document")); }
          }
          return nativeFetch(input, options);
        };
        window.addEventListener("unhandledrejection", event => console.debug("VORTON_TEST_REJECTION", JSON.stringify({ documentToken, url: location.href, reason: String(event.reason), stack: event.reason?.stack })));
        window.addEventListener("error", event => console.debug("VORTON_TEST_ERROR", JSON.stringify({ documentToken, url: location.href, message: event.message, file: event.filename, line: event.lineno })));
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", event => {
              const workspace = event.data?.result;
              if (holdCopyRead && !sessionStorage.getItem("vorton-test-copy-read-held") && workspace?.metadata?.cursor === 1 &&
                  workspace.stagedMetadata && JSON.parse(workspace.stagedMetadata.body).syncCursor === 2) {
                sessionStorage.setItem("vorton-test-copy-read-held", "yes");
                event.stopImmediatePropagation();
                window.releasePostCopyRead = () => { delete window.releasePostCopyRead; this.dispatchEvent(new MessageEvent("message", { data: event.data })); };
                return;
              }
              if (window.dropLocalConfirmation && event.data?.result?.status === "locally-saved") {
                window.dropLocalConfirmation = false; event.stopImmediatePropagation();
                window.interruptLocalConfirmation = () => this.dispatchEvent(new ErrorEvent("error", { message: "Synthetic lost local confirmation" }));
              }
              if (window.dropResolutionConfirmation && event.data?.result?.resolutionId) {
                window.dropResolutionConfirmation = false; event.stopImmediatePropagation();
                window.interruptResolutionConfirmation = () => this.dispatchEvent(new ErrorEvent("error", { message: "Synthetic lost copy confirmation" }));
              }
            });
          }
        };
      }, { faultMode: process.env.HISTORY_RELOAD_FAULT ?? "reload", holdCopyRead: phase === "reopen-copy-sync" });
      page = await browser.newPage(); page.on("pageerror", error => { errors.push(error.message); trace.push({ phase, type: "pageerror", message: error.message, stack: error.stack }); });
      page.on("console", message => { if (message.text().startsWith("VORTON_TEST_")) trace.push({ phase, type: "diagnostic", message: message.text() }); });
      page.on("request", request => trace.push({ phase, type: "request", url: request.url(), method: request.method(), resource: request.resourceType() }));
      page.on("requestfailed", request => trace.push({ phase, type: "requestfailed", url: request.url(), error: request.failure()?.errorText }));
      page.on("response", response => trace.push({ phase, type: "response", url: response.url(), status: response.status() }));
      await page.goto(origin + "/lastresort/forge/tasks", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    };
    const create = async title => {
      await page.getByRole("button", { name: "New task", exact: true }).click();
      await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
      await page.getByRole("button", { name: "Save task", exact: true }).click();
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
    };
    const waitTasks = async count => {
      const end = Date.now() + 15000;
      do {
        if ((await app.store.read("LastResort")).tasks.length === count) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (Date.now() < end);
      assert.equal((await app.store.read("LastResort")).tasks.length, count);
    };
    await reopen(); await create("Accepted before restore"); await waitTasks(1);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await browser.route("**/api/lastresort/sync", route => route.abort());
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Unsent through restored history");
    await page.evaluate(() => { window.dropLocalConfirmation = true; });
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.waitForFunction(() => typeof window.interruptLocalConfirmation === "function");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Newer text after interrupted capture");
    await page.evaluate(() => window.interruptLocalConfirmation());
    await page.getByText(/Retry this saved attempt/).first().waitFor();
    await page.getByRole("button", { name: "Close editor", exact: true }).click();
    const before = await app.store.replicaState("LastResort");
    const serverAdoption = await app.store.adoptHistory("LastResort", { requestId: randomUUID(), expectedGeneration: before.syncGeneration, expectedRevision: before.revision });
    await browser.unroute("**/api/lastresort/sync");
    phase = "restored-reload";
    await page.reload({ waitUntil: "domcontentloaded" });
    const control = page.getByRole("button", { name: "Restored history needs review", exact: true });
    await control.click();
    await page.getByRole("button", { name: "Compare restored history", exact: true }).click();
    phase = "history-review";
    const differences = page.getByRole("list", { name: "Restored history differences", exact: true });
    await differences.waitFor();
    assert.equal(await differences.getByRole("listitem").count(), 1);
    assert.match(await differences.innerText(), /Unsent through restored history/);
    assert.match(await differences.innerText(), /Local intent without confirmed acceptance/);
    await page.screenshot({ path: path.join(root, "phone-comparison.png"), fullPage: true });
    await page.getByRole("button", { name: "Adopt restored history", exact: true }).click();
    phase = "adopted";
    await page.getByRole("heading", { name: "Restored server history", exact: true }).waitFor({ state: "hidden" });
    const pending = page.getByRole("list", { name: "Pending local changes", exact: true });
    assert.equal(await pending.getByRole("listitem").count(), 1);
    assert.match(await pending.innerText(), /Conflict/);
    assert.equal((await app.store.read("LastResort")).tasks.length, 1);
    const bounds = await page.locator("#connection-status-panel").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(":focus").getAttribute("aria-haspopup"), "dialog");
    await browser.close(); browser = undefined;
    phase = "reopen-conflict";
    await reopen();
    await page.getByRole("button", { name: /1 pending local changes/ }).click();
    const restoredPending = page.getByRole("list", { name: "Pending local changes", exact: true });
    await restoredPending.locator("strong").filter({ hasText: "Unsent through restored history" }).waitFor();
    assert.equal((await app.store.read("LastResort")).tasks.length, 1, "reopen cannot automatically replay the difference");
    await restoredPending.getByText("Review change", { exact: true }).click();
    await page.evaluate(() => { window.dropResolutionConfirmation = true; });
    phase = "lost-copy-confirmation";
    await restoredPending.getByRole("button", { name: "Create a copy", exact: true }).click();
    await page.waitForFunction(() => typeof window.interruptResolutionConfirmation === "function");
    await page.evaluate(() => window.interruptResolutionConfirmation());
    await page.getByRole("alert").filter({ hasText: "Device storage stopped" }).waitFor();
    phase = "closing-after-copy-commit";
    await browser.close(); browser = undefined;
    phase = "reopen-copy-sync";
    await reopen();
    await waitTasks(2);
    await page.waitForFunction(() => typeof window.releasePostCopyRead === "function");
    phase = "reload-after-copy";
    if (process.env.HISTORY_RELOAD_FAULT === "alive") await page.evaluate(() => window.releasePostCopyRead());
    else await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    let after = await app.store.read("LastResort");
    assert.equal(after.tasks.length, 2);
    assert.equal(after.tasks.filter(task => task.title === "Unsent through restored history").length, 1);
    assert.equal(after.syncGeneration, serverAdoption.generation);
    const copyId = after.tasks.find(task => task.title === "Unsent through restored history").id;
    phase = "retry-original-attempt";
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const retainedTitle = page.getByRole("textbox", { name: "Title", exact: true });
    await retainedTitle.waitFor();
    assert.equal(await retainedTitle.inputValue(), "Newer text after interrupted capture");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.getByText("The submitted version was saved. Newer edits remain a local draft.", { exact: true }).waitFor();
    assert.equal((await app.store.read("LastResort")).tasks.length, 2, "resolving the original attempt cannot create another copy");
    assert.equal(await retainedTitle.inputValue(), "Newer text after interrupted capture");
    await page.getByRole("button", { name: "Review current records", exact: true }).click();
    await page.getByRole("button", { name: "Use reviewed revision for this draft", exact: true }).click();
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    const updateDeadline = Date.now() + 15000;
    do {
      after = await app.store.read("LastResort");
      if (after.tasks.some(task => task.id === copyId && task.title === "Newer text after interrupted capture")) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < updateDeadline);
    assert.equal(after.tasks.length, 2);
    assert.equal(after.tasks.find(task => task.id === copyId).title, "Newer text after interrupted capture");
    phase = "legacy-draft";
    // Preserve a pre-generation draft through read clearing. No editor is
    // mounted while the test removes only its history identity.
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Legacy draft retained for review");
    await page.evaluate(async () => {
      const deadline = performance.now() + 10000;
      do {
        const saved = await new Promise((resolve, reject) => {
          const request = indexedDB.open("vorton-offline-v1", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction("drafts", "readonly"), rows = tx.objectStore("drafts").getAll();
            tx.oncomplete = () => { db.close(); resolve(rows.result.some(row => row.fields.title === "Legacy draft retained for review")); };
            tx.onerror = () => { db.close(); reject(tx.error); };
          };
        });
        if (saved) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      throw Error("Draft did not persist before read clearing");
    });
    await page.getByRole("button", { name: "Close editor", exact: true }).click();
    await page.getByLabel("Switch installation", { exact: true }).click();
    await page.getByRole("button", { name: "Offline and device storage", exact: true }).click();
    const storage = page.getByRole("dialog", { name: "Offline and device storage", exact: true });
    await storage.getByRole("button", { name: "Clear saved read copies", exact: true }).click();
    phase = "legacy-read-clear";
    await storage.getByText("Saved read copies were cleared. Local drafts and save confirmations remain on this device.", { exact: true }).waitFor();
    await storage.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    await storage.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("vorton-offline-v1", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("drafts", "readwrite"), cursor = tx.objectStore("drafts").openCursor();
        let changed = false;
        cursor.onsuccess = () => { const row = cursor.result; if (!row) return;
          if (row.value.fields.title === "Legacy draft retained for review") {
            const baseline = { ...row.value.baseline }; delete baseline.syncGeneration;
            row.update({ ...row.value, baseline }); changed = true;
          }
          row.continue();
        };
        tx.oncomplete = () => { db.close(); changed ? resolve() : reject(Error("Legacy draft was missing")); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const legacyTitle = page.getByRole("textbox", { name: "Title", exact: true });
    await legacyTitle.waitFor();
    assert.equal(await legacyTitle.inputValue(), "Legacy draft retained for review");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.getByRole("dialog", { name: "New task", exact: true }).getByRole("alert").filter({ hasText: "This draft has no reviewed server history" }).waitFor();
    assert.equal((await app.store.read("LastResort")).tasks.length, 2);
    assert.equal(await legacyTitle.inputValue(), "Legacy draft retained for review");
    await page.getByRole("button", { name: "Review current records", exact: true }).click();
    await page.getByRole("button", { name: "Use reviewed revision for this draft", exact: true }).click();
    assert.equal((await app.store.read("LastResort")).tasks.length, 2, "review itself cannot submit the legacy text");
    await page.getByRole("button", { name: "Save task", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await waitTasks(3);
    after = await app.store.read("LastResort");
    assert.equal(after.tasks.filter(task => task.title === "Legacy draft retained for review").length, 1);
    assert.deepEqual(errors, []);
    const postHideFetches = trace.filter(event => event.type === "diagnostic" && event.message.startsWith("VORTON_TEST_FETCH "))
      .map(event => JSON.parse(event.message.slice("VORTON_TEST_FETCH ".length))).filter(event => event.hidden);
    assert.deepEqual(postHideFetches, [], "a closing document cannot start the held change-feed request");
    await writeFile(path.join(root, "verified.json"), JSON.stringify({ engine: process.env.OFFLINE_ENGINE ?? "chromium", browser: browser.browser()?.version(), faultMode: process.env.HISTORY_RELOAD_FAULT ?? "reload",
      retainedOneUnsentDifference: true, adoptionDidNotSend: true, reopenDidNotSend: true, explicitCopyCount: 1,
      originalAttemptRecoveredAfterLostCopyConfirmation: true, newerTextUpdatedExistingCopy: true,
      postCopyPageHideFetches: postHideFetches.length,
      legacyDraftReviewedAfterReadClear: true, serverTasks: after.tasks.length, serviceWorkerEnabled: true, errors, trace }, null, 2));
    t.diagnostic(`Retained browser evidence: ${root}`);
  } catch (error) {
    await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(path.join(root, "failure.json"), JSON.stringify({ error: error.message, errors, phase, trace,
      text: await page?.locator("body").innerText().catch(() => null) }, null, 2));
    console.error(`Retained isolated history failure: ${root}`); throw error;
  } finally {
    await browser?.close();
    if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
  }
});
