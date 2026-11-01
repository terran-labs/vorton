import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { chromium, webkit } from "playwright-core";
import { createCoreServer } from "../server/core-http.mjs";

test("phone updates wait for editor saves and resume after filters lose focus", {
  skip: !process.env.OFFLINE_BROWSER && process.env.OFFLINE_ENGINE !== "webkit", timeout: 120000,
}, async t => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/pwa-update-safety-")), dist = path.join(root, "served");
  const holdDraft = Boolean(process.env.UPDATE_HELD_DRAFT), savedTitle = holdDraft ? "Retained after pending draft" : "Retained while code updates";
  const viewport = process.env.UPDATE_VIEWPORT === "desktop" ? { width: 1440, height: 1000 } : { width: 390, height: 844 };
  const saveVersion = holdDraft ? "C" : "B", filterVersion = holdDraft ? "D" : "C";
  const importVersion = holdDraft ? "E" : "D";
  await writeFile(path.join(root, "harness.mjs"), await readFile(new URL(import.meta.url)));
  let app, browser, page, phase = "build";
  const errors = [], trace = [];
  const expectNoNavigation = async () => {
    const token = await page.evaluate(() => window.fixtureDocument);
    await page.waitForFunction(token => window.fixtureDocument !== token, token, { timeout: 1000 }).then(
      () => { throw Error("An update replaced a protected editor or focused filter"); },
      error => { assert.equal(error.name, "TimeoutError"); },
    );
  };
  try {
    for (const version of holdDraft ? ["A", "B", "C", "D", "E"] : ["A", "B", "C", "D"]) await build({
      configFile: path.resolve("vite.config.js"), logLevel: "silent",
      plugins: [{ name: "fixture-release", transformIndexHtml: { order: "pre", handler: html => html.replace("<head>", `<head><meta name="fixture-release" content="${version}">`) } }],
      build: { outDir: path.join(root, version), emptyOutDir: true },
    });
    await cp(path.join(root, "A"), dist, { recursive: true });
    app = createCoreServer({ root, dist, port: 0 });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    app.hosts.add(new URL(origin).host); app.allowed.add(origin);
    const engine = process.env.OFFLINE_ENGINE === "webkit" ? webkit : chromium;
    browser = await engine.launchPersistentContext(path.join(root, "browser"), {
      ...(engine === chromium ? { executablePath: process.env.OFFLINE_BROWSER } : {}), headless: true,
      viewport, reducedMotion: "reduce",
    });
    await browser.addInitScript(({ holdDraft }) => {
      window.fixtureDocument = crypto.randomUUID();
      window.addEventListener("pagehide", () => console.debug("VORTON_UPDATE_PAGEHIDE", window.fixtureDocument));
      if (!holdDraft) return;
      window.fixtureHeldDrafts = [];
      window.fixtureReleaseDrafts = () => { window.fixtureHoldDrafts = false; for (const complete of window.fixtureHeldDrafts.splice(0)) complete(); };
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", { ...descriptor, set(handler) {
        descriptor.set.call(this, typeof handler !== "function" ? handler : function(event) {
          const deliver = () => handler.call(this, event);
          if (window.fixtureHoldDrafts && this.mode === "readwrite" && this.objectStoreNames.contains("drafts")) window.fixtureHeldDrafts.push(deliver);
          else deliver();
        });
      } });
    }, { holdDraft });
    page = await browser.newPage();
    page.on("pageerror", error => { errors.push(error.message); trace.push({ phase, type: "pageerror", message: error.message, stack: error.stack, url: page.url() }); });
    page.on("console", message => { if (message.text().startsWith("VORTON_UPDATE_")) trace.push({ phase, type: "lifecycle", message: message.text() }); });
    page.on("requestfailed", request => trace.push({ phase, type: "requestfailed", url: request.url(), error: request.failure()?.errorText }));
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) trace.push({ phase, type: "navigation", url: frame.url() }); });
    await page.goto(origin + "/lastresort/forge/tasks", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Retained while code updates");
    await page.evaluate(() => navigator.serviceWorker.ready);
    let originalDocument = await page.evaluate(() => window.fixtureDocument);
    if (holdDraft) {
      phase = "pending-draft-after-close";
      await page.evaluate(() => { window.fixtureHoldDrafts = true; });
      await page.getByRole("textbox", { name: "Title", exact: true }).fill(savedTitle);
      await page.waitForFunction(() => window.fixtureHeldDrafts.length > 0);
      await page.getByRole("button", { name: "Close editor", exact: true }).click();
      await cp(path.join(root, "B"), dist, { recursive: true });
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).update());
      await page.waitForFunction(() => document.querySelector(".connection-status-button")?.getAttribute("aria-label")?.startsWith("Update ready"));
      await expectNoNavigation();
      assert.equal(await page.evaluate(() => window.fixtureDocument), originalDocument);
      await page.getByRole("button", { name: "Update ready. Update details", exact: true }).click();
      const panel = page.locator("#connection-status-panel");
      assert.equal(await panel.getByRole("button", { name: "Reload with update", exact: true }).isDisabled(), true);
      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await page.evaluate(() => window.fixtureReleaseDrafts());
      await page.waitForFunction(() => document.querySelector('meta[name="fixture-release"]')?.getAttribute("content") === "B" && document.querySelector(".ftv"));
      await page.getByRole("button", { name: "New task", exact: true }).click();
      await page.waitForFunction(title => document.querySelector('input[name="title"]')?.value === title, savedTitle);
      originalDocument = await page.evaluate(() => window.fixtureDocument);
    }
    phase = "update-with-editor";
    await cp(path.join(root, saveVersion), dist, { recursive: true });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).update());
    await page.waitForFunction(() => document.querySelector(".connection-status-button")?.getAttribute("aria-label")?.startsWith("Update ready"));
    await expectNoNavigation();
    assert.equal(await page.evaluate(() => window.fixtureDocument), originalDocument);
    assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), savedTitle);
    assert.equal((await app.store.read("LastResort")).tasks.length, 0);
    await page.screenshot({ path: path.join(root, "editor-held.png"), fullPage: true });
    phase = "save-and-switch";
    await page.locator("dialog[open]").getByRole("button", { name: "Save task", exact: true }).click();
    await page.waitForFunction(version => document.querySelector('meta[name="fixture-release"]')?.getAttribute("content") === version && document.querySelector(".ftv"), saveVersion);
    const secondDocument = await page.evaluate(() => window.fixtureDocument);
    assert.notEqual(secondDocument, originalDocument);
    await page.getByRole("button", { name: savedTitle, exact: true }).waitFor();
    assert.equal((await app.store.read("LastResort")).tasks.length, 1);
    phase = "filter-and-switch";
    await page.getByRole("searchbox", { name: "Search Forge", exact: true }).fill("temporary filter");
    const before = page.url();
    await cp(path.join(root, filterVersion), dist, { recursive: true });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).update());
    await page.waitForFunction(() => document.querySelector(".connection-status-button")?.getAttribute("aria-label")?.startsWith("Update ready"));
    assert.equal(await page.getByRole("searchbox", { name: "Search Forge", exact: true }).evaluate(input => input === document.activeElement), true,
      "Status renders must not steal focus when a filter changes only the query");
    await expectNoNavigation();
    assert.equal(new URL(page.url()).pathname, new URL(before).pathname);
    assert.equal(await page.evaluate(() => window.fixtureDocument), secondDocument);
    await page.getByRole("link", { name: "Tasks", exact: true }).focus();
    await page.waitForFunction(version => document.querySelector('meta[name="fixture-release"]')?.getAttribute("content") === version && document.querySelector(".ftv"), filterVersion);
    assert.equal(await page.getByRole("searchbox", { name: "Search Forge", exact: true }).inputValue(), "temporary filter", "The update preserves the filter query");
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.getByRole("button", { name: savedTitle, exact: true }).waitFor();
    assert.equal((await app.store.read("LastResort")).tasks.length, 1);
    phase = "standalone-import-editor";
    await page.getByRole("link", { name: "Council", exact: true }).click();
    await page.getByText("Import executive recommendations", { exact: true }).click();
    const packet = '{"draft":"Owner packet not yet imported"}';
    await page.getByRole("textbox", { name: "Recommendations JSON", exact: true }).fill(packet);
    await page.getByRole("link", { name: "Forge", exact: true }).focus();
    const importDocument = await page.evaluate(() => window.fixtureDocument);
    await cp(path.join(root, importVersion), dist, { recursive: true });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).update());
    await page.waitForFunction(() => document.querySelector(".connection-status-button")?.getAttribute("aria-label")?.startsWith("Update ready"));
    await expectNoNavigation();
    assert.equal(await page.evaluate(() => window.fixtureDocument), importDocument);
    assert.equal(await page.getByRole("textbox", { name: "Recommendations JSON", exact: true }).inputValue(), packet);
    await page.getByRole("button", { name: "Update ready. Update details", exact: true }).click();
    const updatePanel = page.locator("#connection-status-panel");
    assert.equal(await updatePanel.getByRole("button", { name: "Reload with update", exact: true }).isDisabled(), true);
    await updatePanel.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("textbox", { name: "Recommendations JSON", exact: true }).fill("");
    await page.getByRole("link", { name: "Forge", exact: true }).focus();
    await page.waitForFunction(version => document.querySelector('meta[name="fixture-release"]')?.getAttribute("content") === version &&
      document.querySelector('textarea[aria-label="Recommendations JSON"]'), importVersion);
    await page.getByText("Import executive recommendations", { exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Recommendations JSON", exact: true }).inputValue(), "");
    assert.equal((await app.store.read("LastResort")).tasks.length, 1);
    assert.deepEqual(errors, []);
    await writeFile(path.join(root, "verified.json"), JSON.stringify({ engine: process.env.OFFLINE_ENGINE ?? "chromium", viewport, editorHeld: true,
      automaticSwitchAfterSave: true, automaticSwitchAfterFilterBlur: true, heldDraftConfirmation: holdDraft,
      standaloneImportHeldUntilCleared: true, finalTasks: 1, errors, trace }, null, 2));
    t.diagnostic(`Retained update safety evidence: ${root}`);
  } catch (error) {
    await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(path.join(root, "failure.json"), JSON.stringify({ phase, error: error.message, errors, trace,
      focus: await page?.evaluate(() => document.activeElement?.outerHTML).catch(() => null), text: await page?.locator("body").innerText().catch(() => null) }, null, 2));
    console.error(`Retained update safety failure: ${root}`); throw error;
  } finally { await browser?.close(); if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); } }
});
