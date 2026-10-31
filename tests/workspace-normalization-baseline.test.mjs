import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Store } from "../server/store.mjs";
import { SqliteReplica } from "../server/sqlite-replica.ts";
import { councilPacket } from "../server/council.mjs";
import { canonicalJson } from "../shared/sync-contract.ts";

async function directory(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vorton-normalization-baseline-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("v1 workspace serialization retains property and collection order, opaque shapes and duplicate logs across SQL reopen", async t => {
  const filename = path.join(await directory(t), "state.sqlite3"), scope = "Synthetic";
  // Deliberately different from canonical key order. Council hashes this order.
  const task = JSON.parse('{"title":"Café fixture","id":"TASK-B","version":71,"status":"todo","z":{"b":null,"a":[]},"__proto__":{"publicFixture":true},"history":[{"z":1,"a":2}]}');
  const state = JSON.parse('{"10":"ten","2":"two","schema":1,"profile":"Synthetic","revision":17}');
  Object.assign(state, { tasks: [task, { id: "TASK-A", title: "Second", status: "done" }], goals: [], ideas: [],
    events: [{ id: "duplicate", detail: "first" }, { id: "duplicate", detail: "second" }],
    requests: [{ id: "same", command: "opaque first" }, { id: "same", command: "opaque second" }],
    strategicAudit: [null, { id: "duplicate", extra: [false, 0, ""] }, { id: "duplicate" }],
    auxiliary: { z: { revision: 9, rows: [null, { b: 2, a: 1 }] }, a: null },
    canonical: { goals: [], tasks: [{ action_id: "TASK-B", unknown_column: "retained" }] },
    councilSessions: null, missingVersusNull: null, unknownArray: [3, 1, 3] });
  const bytes = JSON.stringify(state), source = { publicSynthetic: true, raw: "fixture\r\n" };
  let db = new SqliteReplica(filename);
  const imported = db.importWorkspace(scope, state, source), generation = db.generation(scope), changes = db.changes(scope);
  const retained = db.db.prepare("SELECT source FROM replica_imports WHERE scope=?").get(scope).source;
  db.close(); db = new SqliteReplica(filename); t.after(() => db.close());
  assert.equal(JSON.stringify(db.snapshot(scope)), bytes);
  assert.deepEqual(db.changes(scope), changes);
  assert.equal(db.generation(scope), generation);
  assert.equal(db.importWorkspace(scope, state, source), imported);
  assert.equal(imported, createHash("sha256").update(canonicalJson({ source, snapshot: state })).digest("hex"));
  assert.equal(db.db.prepare("SELECT source FROM replica_imports WHERE scope=?").get(scope).source, retained);
  assert.equal(Object.hasOwn(db.snapshot(scope).tasks[0], "__proto__"), true);
  assert.equal(Object.hasOwn(db.snapshot(scope), "absent"), false);
  assert.equal(db.snapshot(scope).tasks[0].version, 71);
  assert.equal(db.record(scope, "task", "TASK-B").revision, 1);
  assert.notEqual(JSON.stringify(db.record(scope, "task", "TASK-B").value), JSON.stringify(task));
});

test("Council evidence uses retained raw entity order across actual Store reopen", async t => {
  const root = await directory(t), store = new Store(root), state = await store.read("Synthetic");
  state.tasks = [{ title: "Public fixture", id: "TASK-Z", status: "todo", version: 8, unknown: { z: 1, a: 2 }, history: [] }];
  state.canonical = { goals: [], tasks: [{ action_id: "TASK-Z", z: "last", a: "first" }] };
  await store.restoreSnapshot("Synthetic", state);
  const before = councilPacket(await store.read("Synthetic"));
  const after = councilPacket(await new Store(root).read("Synthetic"));
  assert.equal(JSON.stringify(after.packet), JSON.stringify(before.packet));
  assert.equal(after.evidenceDigest, before.evidenceDigest);
  const changed = structuredClone(after.packet);
  changed.tasks[0] = Object.fromEntries(Object.entries(changed.tasks[0]).reverse());
  assert.notEqual(createHash("sha256").update(JSON.stringify(changed)).digest("hex"), before.evidenceDigest);
});

test("first legacy duplicate receipt and canonical identity survive reopen without reducing again", async t => {
  const root = await directory(t), store = new Store(root), requestId = randomUUID();
  const command = { requestId, expectedRevision: 0, action: "goal.create", payload: { fields: { title: "Café" } } };
  const legacy = JSON.stringify({ payload: command.payload, action: command.action, expectedRevision: 0, requestId }, null, 2).replace("Café", "Caf\\u00e9");
  const state = await store.read("Synthetic"); state.revision = 9;
  state.requests = [{ id: requestId, command: legacy }, { id: requestId, command: "opaque conflicting duplicate" }];
  state.events = [{ id: "duplicate" }, { id: "duplicate" }];
  await store.restoreSnapshot("Synthetic", state);
  const reopened = new Store(root), before = await reopened.read("Synthetic");
  const result = await reopened.transact("Synthetic", command, () => { assert.fail("durable replay ran reducer"); });
  assert.equal(result.revision, 9);
  assert.deepEqual(result.requests, state.requests);
  assert.deepEqual(result.events, before.events);
  await assert.rejects(reopened.command("Synthetic", { ...command, payload: { fields: { title: "Substitution" } } }), /identity was reused/);
});

test("sync receipt identity, tombstones and generation fences survive SQL reopen and adoption", async t => {
  const root = await directory(t), store = new Store(root);
  const operation = { operationId: randomUUID(), kind: "task", id: randomUUID(), action: "create", expectedRevision: 0, value: { title: "Public task" } };
  const accepted = await store.sync("Synthetic", operation);
  const remove = { operationId: randomUUID(), kind: "task", id: operation.id, action: "delete", expectedRevision: 1 };
  const removed = await store.sync("Synthetic", remove);
  const reopened = new Store(root), before = await reopened.read("Synthetic");
  assert.deepEqual(await reopened.sync("Synthetic", operation), accepted);
  assert.deepEqual(await reopened.sync("Synthetic", remove), removed);
  const adoption = await reopened.adoptHistory("Synthetic", { requestId: randomUUID(), expectedGeneration: before.syncGeneration, expectedRevision: before.revision });
  await assert.rejects(reopened.sync("Synthetic", operation, { generation: accepted.generation }), error => error.code === "history-changed");
  const replay = await new Store(root).sync("Synthetic", operation, { generation: adoption.generation });
  assert.deepEqual({ ...replay, generation: accepted.generation }, accepted);
  const after = await reopened.read("Synthetic");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.tasks.length, 0);
  assert.equal((await reopened.changes("Synthetic")).changes.at(-1).deleted, true);
});

test("all command families preserve their complete JSON, Council evidence and receipt identity across reopen", async t => {
  const root = await directory(t), store = new Store(root);
  const initial = await store.read('Synthetic');
  initial.governance = { tasks: { retainCompletedOutcomes: true, requireCompletionEvidence: true } };
  initial.taskOutcomes = [];
  initial.opaque = JSON.parse('{"z":null,"a":[false,0,""],"__proto__":{"public":true}}');
  await store.restoreSnapshot('Synthetic',initial);
  const actions = [], commands = [];
  const execute = async (action,payload) => {
    const baseline = await store.read('Synthetic');
    const command = { requestId:randomUUID(),expectedRevision:baseline.revision,expectedGeneration:baseline.syncGeneration,action,payload };
    const saved = await store.command('Synthetic',command), reopened = new Store(root);
    const read = await reopened.read('Synthetic',{includeSyncCursor:true});
    assert.equal(JSON.stringify(read),JSON.stringify(saved),action);
    assert.equal(JSON.stringify(await reopened.command('Synthetic',command)),JSON.stringify(read),`${action} receipt replay`);
    const before = councilPacket(saved), after = councilPacket(read);
    assert.equal(JSON.stringify(before.packet),JSON.stringify(after.packet),action);
    assert.equal(before.evidenceDigest,after.evidenceDigest,action);
    assert.deepEqual(read.opaque,initial.opaque);
    commands.push(command); actions.push(action);
    return saved;
  };
  let state = await execute('goal.create',{fields:{title:'Synthetic goal'}}), goal = state.goals[0];
  state = await execute('goal.update',{id:goal.id,fields:{title:'Refined goal'}});
  assert.equal(state.goals[0].history[0].fields.title,'Synthetic goal');
  state = await execute('task.create',{fields:{title:'Synthetic task',goalId:goal.id}});
  const task = state.tasks[0];
  state = await execute('task.update',{id:task.id,fields:{title:task.title,goalId:goal.id,status:'done',notes:'Public synthetic completion evidence'}});
  assert.equal(state.taskOutcomes[0].taskId,task.id);
  state = await execute('task.create',{fields:{title:'Disposable task'}});
  await execute('task.delete',{id:state.tasks.at(-1).id});
  state = await execute('idea.create',{fields:{title:'Public idea'}}); const idea = state.ideas[0];
  await execute('idea.update',{id:idea.id,fields:{title:'Assessed idea',pull:'high'}});
  state = await execute('idea.graduate',{id:idea.id,targetVersion:2,fields:{title:'Committed idea',successCriteria:'Synthetic success evidence'}});
  assert.equal(state.ideas[0].status,'graduated');
  state = await execute('idea.create',{fields:{title:'Disposable idea'}});
  await execute('idea.delete',{id:state.ideas.at(-1).id});
  state = await execute('goal.create',{fields:{title:'Disposable goal'}});
  await execute('goal.delete',{id:state.goals.at(-1).id});
  const opportunity = {title:'Synthetic booking',owner:'Owner',kind:'booking',status:'new',valueCents:100};
  state = await execute('opportunity.create',{fields:opportunity});
  await execute('opportunity.update',{id:state.opportunities[0].id,fields:{...opportunity,status:'qualified'}});
  const entry = {title:'Synthetic expense',kind:'expense',amountCents:100,date:'2026-01-01',category:'Fixture'};
  state = await execute('entry.create',{fields:entry});
  await execute('entry.update',{id:state.ledger[0].id,fields:{...entry,amountCents:200}});
  await execute('settings.update',{defaultOwner:'Public owner',purpose:'Synthetic baseline'});
  await execute('finance.plan.update',{openingCashCents:0,rooms:1,days:1,occupancy:0,rateCents:0,variableCents:0,fixedCents:0});
  state = await store.read('Synthetic');
  const recommendation = {role:state.council.identities[0].id,kind:'goal',targetId:'',rationale:'Public evidence',tradeoffs:'Owner time',confidence:'medium',evidence:'synthetic.md',proposal:{title:'Proposed goal'}};
  state = await execute('recommendation.create',recommendation);
  state = await execute('recommendation.resolve',{id:state.recommendations[0].id,decision:'accepted',note:'Synthetic local approval'});
  await execute('recommendations.import',{contract:'vorton-local.recommendations.v1',profile:'Synthetic',basedOnRevision:state.revision,recommendations:[{...recommendation,proposal:{title:'Another advisory goal'}}]});
  state = await store.read('Synthetic'); const packet = councilPacket(state);
  await execute('council.publish',{contract:packet.contract,sessionId:packet.sessionId,evidenceDigest:packet.evidenceDigest,summary:'Synthetic Council report',bundle:{contract:'vorton-local.recommendations.v1',profile:'Synthetic',basedOnRevision:state.revision,recommendations:[]}});
  const final = await new Store(root).read('Synthetic');
  assert.deepEqual(final.events.map(event=>event.action),actions);
  assert.deepEqual(final.requests.map(request=>request.command),commands.map(canonicalJson));
  assert.equal(final.requests.length,commands.length);
  assert.equal(final.revision,commands.length);
  assert.equal(final.preferenceHistory.length,2);
  assert.equal(final.councilSessions.length,1);
});
