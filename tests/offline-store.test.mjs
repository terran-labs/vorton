import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { chromium } from "playwright-core";

const source = await readFile(new URL("../web/application/offline-store.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const store = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const identity = { installationId: randomUUID(), variant: "private" };

test("unavailable storage returns an explicit failure without blocking online callers", async () => {
  assert.deepEqual(await store.captureOfflineScope(identity), { ok: false, reason: "unavailable" });
  assert.deepEqual(await store.readSavedAdmission("private"), { ok: false, reason: "unavailable" });
  assert.deepEqual(await store.readDrafts({ ...identity, readEpoch: 0, draftEpoch: 0 }), { ok: false, reason: "unavailable" });
  assert.deepEqual(await store.captureOfflineScope({ ...identity, installationId: "not-an-id" }), { ok: false, reason: "invalid" });
});

// Opt in to actual browser IndexedDB. No application build or installation state.
test("durable scopes, envelopes, clear fencing and cross-tab notifications in real IndexedDB", { skip: !process.env.OFFLINE_BROWSER, timeout: 60000 }, async t => {
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", request.url === "/store.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/store.js" ? js : "<!doctype html><title>Isolated storage test</title>");
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.OFFLINE_BROWSER, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage(), other = await context.newPage();
    for (const tab of [page, other]) { await tab.goto(origin); await tab.evaluate(async () => { window.store = await import("/store.js"); }); }
    const config = { identity, otherId: randomUUID() };
    await page.evaluate(async ({ identity, otherId }) => {
      const unwrap = result => { if (!result.ok) throw Error(result.reason); return result.value; };
      window.unwrap = unwrap;
      window.scope = unwrap(await store.captureOfflineScope(identity));
      window.portable = unwrap(await store.captureOfflineScope({ ...identity, variant: "portable" }));
      window.otherScope = unwrap(await store.captureOfflineScope({ ...identity, installationId: otherId }));
      window.key = { ...identity, profile: "AubOS", schema: 1, kind: "workspace", id: "current" };
      window.draftKey = { profile: "AubOS", schema: 1, kind: "task-editor-v1", targetId: "new" };
      window.admission = { ...identity, schema: 1, profiles: ["AubOS"], verifiedAt: 123, lastRoute: "/aubos/forge/tasks" };
      unwrap(await store.saveVerifiedAdmission(scope, admission));
      const model = { key, verifiedAt: 123, value: { profile: "AubOS", commands: [{ description: "Descriptive evidence, no replay" }], evidence: "Synthetic retained evidence. ".repeat(100000) } };
      unwrap(await store.saveVerifiedModel(scope, model));
      window.largeBytes = JSON.stringify(model.value).length;
      window.draft = unwrap(await store.saveDraft(scope, { key: draftKey, fields: { title: "First", ideaIds: ["IDEA-1"] }, baseline: { revision: 123, version: 2, relations: { ideaIds: ["IDEA-1"] } } }));
    }, config);

    await t.test("large representative models survive a fresh document; variant, installation and profile keys isolate", async () => {
      assert.ok(await page.evaluate(() => largeBytes > 2_700_000));
      await other.evaluate(async ({ identity }) => {
        window.scope = window.store.captureOfflineScope(identity).then(result => result.value);
      }, config);
      const result = await other.evaluate(async ({ identity, otherId }) => {
        const saved = await store.readSavedAdmission("private");
        const key = { ...identity, profile: "AubOS", schema: 1, kind: "workspace", id: "current" };
        const scope = saved.value.scope;
        return { admission: saved.value.admission, size: (await store.readSavedModel(scope, key)).value.value.evidence.length,
          drafts: await store.readDrafts(scope), otherDrafts: await store.readDrafts((await store.captureOfflineScope({ ...identity, installationId: otherId })).value),
          portable: await store.readSavedModel((await store.captureOfflineScope({ ...identity, variant: "portable" })).value, { ...key, variant: "portable" }),
          otherProfile: await store.readSavedModel(scope, { ...key, profile: "LastResort" }) };
      }, config);
      assert.equal(result.admission.verifiedAt, 123); assert.ok(result.size > 2_700_000);
      assert.equal(result.portable.value, undefined); assert.equal(result.otherProfile.value, undefined);
      assert.equal(result.drafts.value.length, 1); assert.equal(result.drafts.value[0].fields.title, "First");
      assert.deepEqual(result.otherDrafts.value, []);
      await other.reload(); await other.evaluate(async () => { window.store = await import("/store.js"); });
      assert.equal(await other.evaluate(async () => (await store.readSavedAdmission("private")).value.admission.profiles[0]), "AubOS");
    });

    await t.test("draft timestamps are unique across tabs/deletion and stale CAS cannot erase newer fields", async () => {
      const first = await page.evaluate(() => draft.savedAt);
      const second = await other.evaluate(async ({ identity }) => {
        const scope = (await store.captureOfflineScope(identity)).value;
        return (await store.saveDraft(scope, { key: { profile: "AubOS", schema: 1, kind: "task-editor-v1", targetId: "new" }, fields: { title: "Second" } })).value.savedAt;
      }, config);
      assert.ok(second > first);
      assert.equal(await page.evaluate(async first => (await store.removeDraft(scope, draftKey, first)).value, first), false);
      assert.equal(await page.evaluate(async second => (await store.removeDraft(scope, draftKey, second)).value, second), true);
      const third = await page.evaluate(async () => { window.draft = unwrap(await store.saveDraft(scope, { key: draftKey, fields: { title: "Third" } })); return draft.savedAt; });
      assert.ok(third > second);
    });

    await t.test("credential objects are rejected, descriptive command evidence is permitted", async () => {
      const failures = await page.evaluate(async () => Promise.all([
        store.saveVerifiedAdmission(scope, { ...admission, token: "secret" }),
        store.saveVerifiedModel(scope, { key, verifiedAt: 123, value: new Response("not a model") }),
        store.saveDraft(scope, { key: draftKey, fields: { token: "secret" } }),
      ]));
      assert.ok(failures.every(result => !result.ok && result.reason === "invalid"));
    });

    await t.test("guarded cross-tab draft writes reject stale forms and unknown-result hints without changing the winner", async () => {
      const initial = await page.evaluate(async () => {
        window.casKey = { profile: "AubOS", schema: 1, kind: "idea-editor-v1", targetId: "cas-fixture" };
        window.casDraft = unwrap(await store.saveDraft(scope, { key: casKey, fields: { title: "Original form" }, baseline: { revision: 123 } }, { expectedSavedAt: null }));
        return casDraft;
      });
      const winner = await other.evaluate(async ({ identity, initial }) => {
        const scope = (await store.captureOfflineScope(identity)).value;
        return store.saveDraft(scope, { key: initial.key, fields: { title: "Newer reopened form" }, baseline: { revision: 5 } }, { expectedSavedAt: initial.savedAt });
      }, { identity, initial });
      assert.ok(winner.ok);
      assert.ok(winner.value.savedAt > initial.savedAt);
      const stale = await page.evaluate(async () => ({
        form: await store.saveDraft(scope, { key: casKey, fields: { title: "Delayed older form" } }, { expectedSavedAt: casDraft.savedAt }),
        unknown: await store.saveDraft(scope, { key: casKey, fields: { title: "Old submission", submissionState: "unknown", requestId: "stale-request" } }, { expectedSavedAt: casDraft.savedAt }),
        absent: await store.saveDraft(scope, { key: casKey, fields: { title: "Incorrectly assumed empty" } }, { expectedSavedAt: null }),
        invalid: await store.saveDraft(scope, { key: casKey, fields: {} }, { expectedSavedAt: -1 }),
        retained: await store.readDraft(scope, casKey),
      }));
      for (const name of ["form", "unknown", "absent"]) assert.equal(stale[name].reason, "obsolete");
      assert.equal(stale.invalid.reason, "invalid");
      assert.deepEqual(stale.retained.value, winner.value);
      const updated = await page.evaluate(async winner => store.saveDraft(scope, { key: casKey, fields: { title: "Explicitly based on winner" } }, { expectedSavedAt: winner.savedAt }), winner.value);
      assert.ok(updated.ok);
      assert.ok(updated.value.savedAt > winner.value.savedAt);
      assert.equal(await page.evaluate(async initial => (await store.removeDraft(scope, casKey, initial.savedAt)).value, initial), false);
      assert.equal(await page.evaluate(async updated => (await store.removeDraft(scope, casKey, updated.savedAt)).value, updated.value), true);
      const recreated = await page.evaluate(async () => store.saveDraft(scope, { key: casKey, fields: { title: "New form after deletion" } }, { expectedSavedAt: null }));
      assert.ok(recreated.ok);
      assert.ok(recreated.value.savedAt > updated.value.savedAt);
    });

    await t.test("corrupt admissions, model keys/timestamps and draft envelopes fail before hydration", async () => {
      const results = await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open("vorton-offline-v1", 1); request.onsuccess = () => resolve(request.result); });
        const inject = (name, key, value) => new Promise(resolve => { const tx = db.transaction(name, "readwrite"); tx.objectStore(name).put(value, key); tx.oncomplete = resolve; });
        const results = [];
        for (const damaged of [{ ...admission, profiles: undefined }, { ...admission, schema: 2 }, { ...admission, verifiedAt: NaN }, { ...admission, lastRoute: 4 }]) {
          await inject("readModels", ["admission", "private"], { admission: damaged, readEpoch: 0 }); results.push(await store.readSavedAdmission("private"));
        }
        unwrap(await store.saveVerifiedAdmission(scope, admission));
        for (const damaged of [{ key: { ...key, profile: "LastResort" }, verifiedAt: 1, value: {} }, { key, verifiedAt: NaN, value: {} }]) {
          await inject("readModels", ["model", "private", scope.installationId, "AubOS", 1, "workspace", "current"], damaged); results.push(await store.readSavedModel(scope, key));
        }
        for (const damaged of [{ ...draft, key: { ...draftKey, schema: 2 } }, { ...draft, savedAt: NaN }, { ...draft, fields: [] }, { ...draft, baseline: { version: "wrong" } }]) {
          await inject("drafts", ["draft", "private", scope.installationId, "AubOS", 1, "task-editor-v1", "new"], damaged); results.push(await store.readDraft(scope, draftKey));
        }
        db.close(); unwrap(await store.saveDraft(scope, { key: draftKey, fields: { title: "Retained draft" } }));
        return results;
      });
      assert.ok(results.every(result => !result.ok && result.reason === "invalid"));
    });

    await t.test("reversed cross-tab model saves keep the newer observation and opaque revisions; ties keep first", async () => {
      await page.evaluate(() => {
        window.orderKey = { ...key, id: "ordering" };
        window.olderModel = { key: orderKey, verifiedAt: 100, value: { revision: 99999, title: "Older validated observation" } };
      });
      const newer = await other.evaluate(async ({ identity }) => {
        const scope = (await store.captureOfflineScope(identity)).value;
        const key = { ...identity, profile: "AubOS", schema: 1, kind: "workspace", id: "ordering" };
        return store.saveVerifiedModel(scope, { key, verifiedAt: 200, value: { revision: 1, title: "Newer observation, lower digest" } });
      }, config);
      assert.ok(newer.ok);
      const result = await page.evaluate(async () => ({
        older: await store.saveVerifiedModel(scope, olderModel),
        tied: await store.saveVerifiedModel(scope, { ...olderModel, verifiedAt: 200 }),
        saved: await store.readSavedModel(scope, orderKey),
      }));
      assert.equal(result.older.reason, "obsolete");
      assert.equal(result.tied.reason, "obsolete");
      assert.equal(result.saved.value.value.title, "Newer observation, lower digest");
      assert.equal(result.saved.value.value.revision, 1);
    });

    await t.test("admission pointer rejects delayed prior installations and equal-time authority conflicts", async () => {
      const replacement = await other.evaluate(async ({ identity, otherId }) => {
        const scope = (await store.captureOfflineScope({ ...identity, installationId: otherId })).value;
        return store.saveVerifiedAdmission(scope, { ...identity, installationId: otherId, schema: 1, profiles: ["LastResort"], verifiedAt: 200, lastRoute: "/lastresort/forge/ideas" });
      }, config);
      assert.ok(replacement.ok);
      const result = await page.evaluate(async () => ({
        older: await store.saveVerifiedAdmission(scope, admission),
        tiedIdentity: await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 200 }),
        saved: await store.readSavedAdmission("private"),
      }));
      assert.equal(result.older.reason, "obsolete");
      assert.equal(result.tiedIdentity.reason, "obsolete");
      assert.equal(result.saved.value.admission.installationId, config.otherId);
      const tiedProfiles = await other.evaluate(async () => {
        const saved = (await store.readSavedAdmission("private")).value;
        return store.saveVerifiedAdmission(saved.scope, { ...saved.admission, profiles: ["AubOS"] });
      });
      assert.equal(tiedProfiles.reason, "obsolete");
      await page.evaluate(async () => unwrap(await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 300 })));
    });

    await t.test("request-captured CAS rejects later completion timestamps across tabs and installation pointers", async () => {
      await page.evaluate(async () => {
        window.modelTicket = unwrap(await store.captureReadTicket(scope, orderKey));
        window.admissionTicket = unwrap(await store.captureAdmissionTicket("private"));
      });
      const newer = await other.evaluate(async ({ identity, otherId }) => {
        const scope = (await store.captureOfflineScope(identity)).value;
        const key = { ...identity, profile: "AubOS", schema: 1, kind: "workspace", id: "ordering" };
        const ticket = (await store.captureReadTicket(scope, key)).value;
        const admissionTicket = (await store.captureAdmissionTicket("private")).value;
        const replacement = (await store.captureOfflineScope({ ...identity, installationId: otherId })).value;
        return {
          model: await store.saveVerifiedModel(scope, { key, verifiedAt: 1000, value: { revision: 0, title: "Newer request won" } }, ticket),
          admission: await store.saveVerifiedAdmission(replacement, { ...identity, installationId: otherId, schema: 1, profiles: ["LastResort"], verifiedAt: 400 }, admissionTicket),
          current: await store.readSavedAdmission("private"),
        };
      }, config);
      assert.ok(newer.model.ok && newer.admission.ok);
      assert.equal(newer.current.value.admission.lastRoute, undefined, "Replacement identity never inherits another installation's route");
      const stale = await page.evaluate(async () => ({
        model: await store.saveVerifiedModel(scope, { key: orderKey, verifiedAt: 9000, value: { revision: 9999, title: "Older request finished later" } }, modelTicket),
        admission: await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 9000 }, admissionTicket),
        saved: await store.readSavedModel(scope, orderKey),
        pointer: await store.readSavedAdmission("private"),
      }));
      assert.equal(stale.model.reason, "obsolete");
      assert.equal(stale.admission.reason, "obsolete");
      assert.equal(stale.saved.value.value.title, "Newer request won");
      assert.equal(stale.pointer.value.admission.installationId, config.otherId);
      await page.evaluate(async () => {
        const ticket = unwrap(await store.captureAdmissionTicket("private"));
        unwrap(await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 500 }, ticket));
        const modelTicket = unwrap(await store.captureReadTicket(scope, orderKey));
        unwrap(await store.saveVerifiedModel(scope, { key: orderKey, verifiedAt: 1000, value: { revision: 987, title: "Fresh request with same millisecond" } }, modelTicket));
      });
      assert.equal(await page.evaluate(async () => (await store.readSavedModel(scope, orderKey)).value.value.title), "Fresh request with same millisecond");
    });

    await t.test("same-authority route hints follow invocation order and survive session-only refresh", async () => {
      const clock = Date.now() + 10000;
      await page.evaluate(async clock => {
        const originalNow = Date.now;
        Date.now = () => clock;
        try { unwrap(await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 500, lastRoute: "/aubos/tools" })); }
        finally { Date.now = originalNow; }
      }, clock);
      await other.evaluate(async clock => {
        const saved = (await store.readSavedAdmission("private")).value;
        const originalNow = Date.now;
        Date.now = () => clock + 1000;
        try { await store.saveVerifiedAdmission(saved.scope, { ...saved.admission, lastRoute: "/aubos/finance" }); }
        finally { Date.now = originalNow; }
      }, clock);
      const result = await page.evaluate(async clock => {
        const originalNow = Date.now;
        Date.now = () => clock + 500;
        try {
          unwrap(await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 500, lastRoute: "/aubos/forge/tasks" }));
          Date.now = () => clock + 1000;
          unwrap(await store.saveVerifiedAdmission(scope, { ...admission, verifiedAt: 500, lastRoute: "/aubos/tools" }));
          const refreshed = { ...admission, verifiedAt: 501 }; delete refreshed.lastRoute;
          unwrap(await store.saveVerifiedAdmission(scope, refreshed));
        }
        finally { Date.now = originalNow; }
        return store.readSavedAdmission("private");
      }, clock);
      assert.equal(result.value.admission.lastRoute, "/aubos/finance");
    });

    await t.test("clear reads preserves drafts, notifies other tabs and fences late hydration/saves", async () => {
      await other.evaluate(() => { window.changes = []; window.unsubscribe = store.subscribeOfflineStore(change => changes.push(change)); });
      const next = await page.evaluate(async () => {
        unwrap(await store.saveVerifiedModel(portable, { key: { ...key, variant: "portable" }, verifiedAt: 1, value: { fixture: "Other namespace" } }));
        unwrap(await store.saveVerifiedModel(otherScope, { key: { ...key, installationId: otherScope.installationId }, verifiedAt: 1, value: { fixture: "Other installation" } }));
        window.clearTicket = unwrap(await store.captureAdmissionTicket("private"));
        window.next = unwrap(await store.clearSavedData(scope, "reads")); return next;
      });
      await other.waitForFunction(() => changes.length === 1);
      assert.equal(await other.evaluate(() => changes[0].type), "READS_CLEARED");
      const checks = await page.evaluate(async () => ({
        late: await store.saveVerifiedModel(scope, { key, verifiedAt: 123, value: {} }),
        hydration: await store.isOfflineScopeCurrent(scope), draft: await store.readDraft(scope, draftKey),
        portable: await store.readSavedModel(portable, { ...key, variant: "portable" }),
        other: await store.readSavedModel(otherScope, { ...key, installationId: otherScope.installationId }), admission: await store.readSavedAdmission("private"),
        stalePointer: await store.saveVerifiedAdmission(next, { ...admission, verifiedAt: 9000 }, clearTicket),
      }));
      assert.equal(checks.late.reason, "obsolete"); assert.equal(checks.hydration.value, false);
      assert.equal(checks.stalePointer.reason, "obsolete", "Admission CAS tombstone survives pointer removal");
      assert.equal(checks.draft.value.fields.title, "Retained draft"); assert.ok(checks.portable.value && checks.other.value); assert.equal(checks.admission.value, undefined);
      assert.equal(next.draftEpoch, 0);
    });

    await t.test("forget fences both stores durably and survives reload without resetting timestamps", async () => {
      const forgotten = await page.evaluate(async () => { window.forgotten = unwrap(await store.clearSavedData(next, "all")); return forgotten; });
      await other.waitForFunction(() => changes.length === 2);
      const late = await page.evaluate(async () => Promise.all([store.saveDraft(next, { key: draftKey, fields: { title: "Late" } }), store.saveVerifiedAdmission(next, admission)]));
      assert.ok(late.every(result => result.reason === "obsolete"));
      await other.reload(); await other.evaluate(async () => { window.store = await import("/store.js"); });
      const after = await other.evaluate(async ({ identity }) => {
        const current = (await store.captureOfflineScope(identity)).value;
        const key = { profile: "AubOS", schema: 1, kind: "task-editor-v1", targetId: "new" };
        return { current, absent: await store.readDraft(current, key), fresh: await store.saveDraft(current, { key, fields: { title: "Explicit fresh save" } }) };
      }, config);
      assert.equal(after.current.readEpoch, forgotten.readEpoch); assert.equal(after.current.draftEpoch, forgotten.draftEpoch);
      assert.equal(after.absent.value, undefined); assert.ok(after.fresh.ok);
    });

    await t.test("forget with no admission pointer still fences a session begun before clear", async () => {
      const result = await page.evaluate(async () => {
        const scope = unwrap(await store.captureOfflineScope(portable));
        const ticket = unwrap(await store.captureAdmissionTicket("portable"));
        const next = unwrap(await store.clearSavedData(scope, "all"));
        return store.saveVerifiedAdmission(next, { schema: 1, installationId: next.installationId, variant: "portable", profiles: ["LastResort"], verifiedAt: 10000 }, ticket);
      });
      assert.equal(result.reason, "obsolete");
      // Restore only the isolated quota fixture with an explicit fresh scope.
      await page.evaluate(async () => {
        window.portable = unwrap(await store.captureOfflineScope(portable));
        unwrap(await store.saveVerifiedModel(portable, { key: { ...key, variant: "portable" }, verifiedAt: 1, value: { fixture: "Other namespace" } }));
      });
    });

    await t.test("quota error at the IDB write boundary aborts without replacing existing evidence", async () => {
      const result = await page.evaluate(async () => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException("Storage full", "QuotaExceededError"); };
        try { return await store.saveVerifiedModel(portable, { key: { ...key, variant: "portable" }, verifiedAt: 5, value: { fixture: "Replacement" } }); }
        finally { IDBObjectStore.prototype.put = original; }
      });
      assert.deepEqual(result, { ok: false, reason: "quota" });
      assert.equal(await page.evaluate(async () => (await store.readSavedModel(portable, { ...key, variant: "portable" })).value.value.fixture), "Other namespace");
    });
    await context.close();
  } finally {
    await browser?.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
