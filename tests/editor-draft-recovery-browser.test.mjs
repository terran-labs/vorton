import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, copyFile, chmod, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "vite";
import { chromium, webkit } from "playwright-core";
import { createCoreServer } from "../server/core-http.mjs";

test("phone editors explicitly recover source-key drafts into reviewed copies", {
  skip: !process.env.OFFLINE_BROWSER && process.env.OFFLINE_ENGINE !== "webkit", timeout: 180000,
}, async t => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/editor-draft-recovery-")), errors = [], trace = [];
  await writeFile(path.join(root, "harness.mjs"), await readFile(new URL(import.meta.url)));
  const profile = "LastResort", kinds = ["task", "goal", "idea"], collection = kind => `${kind}s`;
  let app, browser, page, origin, phase = "build";
  const dist = path.join(root, "dist"), engine = process.env.OFFLINE_ENGINE === "webkit" ? webkit : chromium;
  const start = async (port = 0) => {
    app = createCoreServer({ root, dist, port });
    await new Promise(resolve => app.server.listen(port, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
    app.hosts.add(new URL(origin).host); app.allowed.add(origin);
  };
  const stop = async () => { await app.backups.stop(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); };
  const reopen = async () => {
    browser = await engine.launchPersistentContext(path.join(root, "browser"), {
      ...(engine === chromium ? { executablePath: process.env.OFFLINE_BROWSER } : {}), headless: true,
      viewport: { width: 390, height: 844 }, reducedMotion: "reduce",
    });
    await browser.addInitScript(() => {
      const documentToken = crypto.randomUUID(); let hidden = false;
      window.addEventListener("pagehide", event => { hidden = true; console.debug("VORTON_EDITOR_PAGEHIDE", JSON.stringify({ documentToken, url: location.href, persisted: event.persisted })); });
      window.addEventListener("error", event => console.debug("VORTON_EDITOR_ERROR", JSON.stringify({ documentToken, hidden, url: location.href, message: event.message, stack: event.error?.stack })));
      window.addEventListener("unhandledrejection", event => console.debug("VORTON_EDITOR_REJECTION", JSON.stringify({ documentToken, hidden, url: location.href, reason: String(event.reason), stack: event.reason?.stack })));
      const nativeFetch = window.fetch;
      window.fetch = (...args) => { console.debug("VORTON_EDITOR_FETCH", JSON.stringify({ documentToken, hidden, url: String(args[0]), stack: new Error().stack })); return nativeFetch(...args); };
    });
    page = await browser.newPage(); page.on("pageerror", error => { errors.push(error.message); trace.push({ phase, type: "pageerror", url: page.url(), message: error.message, stack: error.stack }); });
    page.on("console", message => { if (message.text().startsWith("VORTON_EDITOR_")) trace.push({ phase, type: "diagnostic", message: message.text() }); });
    page.on("requestfailed", request => trace.push({ phase, type: "requestfailed", url: request.url(), error: request.failure()?.errorText }));
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) trace.push({ phase, type: "document-navigation", url: frame.url() }); });
  };
  const navigate = async kind => {
    const pathname = `/lastresort/forge/${collection(kind)}`;
    trace.push({ phase, type: "navigation-request", pathname, fullDocument: Boolean(process.env.EDITOR_FULL_NAVIGATION) });
    if (process.env.EDITOR_FULL_NAVIGATION || !page.url().startsWith(origin)) await page.goto(origin + pathname, { waitUntil: "domcontentloaded" });
    else if (new URL(page.url()).pathname !== pathname) await page.getByRole("link", { name: collection(kind).replace(/^./, letter => letter.toUpperCase()), exact: true }).click();
  };
  const edit = async (kind, id, title) => {
    await navigate(kind);
    if (kind === "idea") await page.locator(`#idea-${id}`).getByRole("button", { name: "Edit idea", exact: true }).click();
    else if (kind === "goal") await page.getByRole("button", { name: "Edit goal", exact: true }).click();
    else await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).waitFor();
  };
  const deviceDrafts = async (action = "read", id, copy, generation) => page.evaluate(({ action, id, copy, generation }) => new Promise((resolve, reject) => {
    const request = indexedDB.open("vorton-offline-v1", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("drafts", action === "read" ? "readonly" : "readwrite"), store = tx.objectStore("drafts"), cursor = store.openCursor(), rows = [];
      cursor.onsuccess = () => { const row = cursor.result; if (!row) return;
        rows.push(row.value);
        if (row.value.key.targetId === id && action === "change") row.update({ ...row.value, savedAt: row.value.savedAt + 1, fields: { ...row.value.fields, title: "Race newer task" } });
        if (row.value.key.targetId === id && action === "compete") {
          const key = [...row.key]; key[key.length - 1] = copy;
          store.put({ ...row.value, key: { ...row.value.key, targetId: copy }, savedAt: row.value.savedAt + 1,
            fields: { ...row.value.fields, title: "Competing direct draft" }, baseline: { ...row.value.baseline, syncGeneration: generation } }, key);
        }
        row.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(rows); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), { action, id, copy, generation });
  const eventually = async predicate => {
    const end = Date.now() + 15000;
    do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end);
    assert.fail(`Condition did not settle during ${phase}`);
  };
  try {
    await build({ configFile: path.resolve("vite.config.js"), logLevel: "silent", build: { outDir: dist, emptyOutDir: true } });
    await start();
    await app.store.replicaState(profile);
    const databasePath = path.join(root, profile, "state/core.sqlite3"), empty = path.join(root, "empty.sqlite3");
    const database = new DatabaseSync(databasePath); database.prepare("VACUUM INTO ?").run(empty); database.close();
    const originals = {};
    for (const kind of kinds) {
      const before = await app.store.read(profile);
      await app.store.command(profile, { requestId: randomUUID(), expectedRevision: before.revision,
        action: `${kind}.create`, payload: { fields: { title: `Original ${kind}` } } });
      originals[kind] = (await app.store.read(profile))[collection(kind)][0].id;
    }
    await reopen();
    await browser.route("**/api/lastresort/sync", route => route.abort());
    for (const kind of kinds) {
      phase = `retain-${kind}`;
      await edit(kind, originals[kind], `Original ${kind}`);
      await page.getByRole("textbox", { name: "Title", exact: true }).fill(`Queued ${kind}`);
      await page.locator("dialog[open]").getByRole("button", { name: `Save ${kind}`, exact: true }).click();
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
      await edit(kind, originals[kind], `Queued ${kind}`);
      await page.getByRole("textbox", { name: "Title", exact: true }).fill(`Newer unsubmitted ${kind}`);
      await page.getByRole("button", { name: "Close editor", exact: true }).click();
      await eventually(async () => (await deviceDrafts()).some(draft => draft.fields.title === `Newer unsubmitted ${kind}`));
    }
    await browser.close(); browser = undefined;
    phase = "restore-fixture";
    const port = app.server.address().port; await stop(); app = undefined;
    for (const suffix of ["-wal", "-shm", "-journal"]) await rm(databasePath + suffix, { force: true });
    await copyFile(empty, databasePath);
    await chmod(databasePath, 0o600);
    await start(port);
    const before = await app.store.replicaState(profile);
    await app.store.adoptHistory(profile, { requestId: randomUUID(), expectedGeneration: before.syncGeneration, expectedRevision: before.revision });
    await reopen(); await navigate("task");
    await page.getByRole("button", { name: "Restored history needs review", exact: true }).click();
    await page.getByRole("button", { name: "Compare restored history", exact: true }).click();
    const differences = page.getByRole("list", { name: "Restored history differences", exact: true });
    await differences.waitFor(); assert.equal(await differences.getByRole("listitem").count(), 3);
    await page.getByRole("button", { name: "Adopt restored history", exact: true }).click();
    const pending = page.getByRole("list", { name: "Pending local changes", exact: true });
    for (const kind of kinds) {
      const row = pending.getByRole("listitem").filter({ hasText: `Queued ${kind}` });
      await row.getByText("Review change", { exact: true }).click();
      await row.getByRole("button", { name: "Create a copy", exact: true }).click();
    }
    await eventually(async () => { const state = await app.store.read(profile); return kinds.every(kind => state[collection(kind)].length === 1); });
    await browser.close(); browser = undefined; await reopen();
    const copies = await app.store.read(profile);
    for (const kind of kinds) {
      phase = `recover-${kind}`;
      const copy = copies[collection(kind)][0];
      if (kind === "task") {
        const receipt = await app.store.sync(profile, { operationId: randomUUID(), kind, id: originals.task,
          expectedRevision: 0, action: "create", value: { title: "Reappeared original task" } }, { generation: copies.syncGeneration });
        assert.equal(receipt.status, "accepted");
        await edit(kind, originals.task, "Reappeared original task");
        await page.getByText(/This saved draft belongs to a recovery copy/).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "Reappeared original task");
        assert.equal(await page.locator("dialog[open]").getByRole("button", { name: "Save task", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Close editor", exact: true }).click();
      }
      await navigate(kind);
      if (kind === "goal") await deviceDrafts("compete", originals[kind], copy.id, copies.syncGeneration);
      await edit(kind, copy.id, copy.title);
      const panel = page.getByRole("region", { name: "Retained editor drafts", exact: true });
      await panel.getByText(`Newer unsubmitted ${kind}`, { exact: true }).waitFor();
      const bounds = await page.locator("dialog[open]").boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, "the editor fits the phone viewport");
      await page.screenshot({ path: path.join(root, `retained-${kind}.png`), fullPage: true });
      assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), kind === "goal" ? "Competing direct draft" : copy.title);
      assert.ok((await deviceDrafts()).some(draft => draft.key.targetId === originals[kind]), "discovery retains the source slot");
      if (kind === "goal") {
        assert.equal(await panel.getByRole("button", { name: "Use retained draft", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Discard local draft", exact: true }).click();
        await page.locator("dialog[open]").waitFor({ state: "hidden" });
        await edit(kind, copy.id, copy.title);
      }
      if (kind === "task") {
        await deviceDrafts("change", originals[kind]);
        await panel.getByRole("button", { name: "Use retained draft", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "changed during review" }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(), copy.title);
        await panel.getByRole("button", { name: "Refresh retained drafts", exact: true }).click();
        await panel.getByText("Race newer task", { exact: true }).waitFor();
      }
      await panel.getByRole("button", { name: "Use retained draft", exact: true }).click();
      const expected = kind === "task" ? "Race newer task" : `Newer unsubmitted ${kind}`;
      await eventually(async () => await page.getByRole("textbox", { name: "Title", exact: true }).inputValue() === expected);
      assert.equal((await app.store.read(profile))[collection(kind)].find(record => record.id === copy.id).title, copy.title, "explicit review still sends nothing");
      await page.locator("dialog[open]").getByRole("button", { name: `Save ${kind}`, exact: true }).click();
      await page.locator("dialog[open]").waitFor({ state: "hidden" });
      await eventually(async () => (await app.store.read(profile))[collection(kind)].find(record => record.id === copy.id).title === expected);
      const saved = (await app.store.read(profile))[collection(kind)];
      assert.equal(saved.length, kind === "task" ? 2 : 1); assert.equal(saved.filter(record => record.id === copy.id).length, 1);
      if (kind === "task") assert.equal(saved.find(record => record.id === originals.task).title, "Reappeared original task");
      assert.equal((await deviceDrafts()).some(draft => draft.key.targetId === originals[kind]), false, "verified cleanup removes only the source draft");
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, "phone.png"), fullPage: true });
    await writeFile(path.join(root, "verified.json"), JSON.stringify({ kinds, sourceKeyRecovery: true, changedSourceRejected: true,
      ambiguousDraftsPreserved: true, originalIds: originals, state: await app.store.read(profile), serviceWorkersEnabled: true,
      fullDocumentNavigation: Boolean(process.env.EDITOR_FULL_NAVIGATION), errors, trace }, null, 2));
    t.diagnostic(`Retained editor evidence: ${root}`);
  } catch (error) {
    await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(path.join(root, "failure.json"), JSON.stringify({ phase, error: error.message, errors, trace, text: await page?.locator("body").innerText().catch(() => null) }, null, 2));
    console.error(`Retained editor failure: ${root}`); throw error;
  } finally { await browser?.close(); if (app) await stop(); }
});
