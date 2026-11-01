import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, rm, chmod, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from 'node:child_process';
import { SqliteReplica } from "../server/sqlite-replica.ts";
import { MutationJournal } from '../server/workspace-delta.ts';
import { Store } from "../server/store.ts";
import { canonicalJson } from "../shared/sync-contract.ts";
import { hasWorkspaceSnapshot } from "../server/workspace-storage.ts";
import { AuxiliaryState } from "../server/auxiliary-state.ts";
import { createDailyBackup, restoreBackup } from "../server/backup.ts";

const admission = { backupVerified: true, writersExcluded: true };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vorton-normalized-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
// Independent v1 layout, matching the supported old runtime bootstrap. Never
// derive the legacy fixture schema from the new migration or export code.
const v1Schema = `
CREATE TABLE replica_schema(version INTEGER PRIMARY KEY CHECK(version=1)); INSERT OR IGNORE INTO replica_schema VALUES(1);
CREATE TABLE replica_records(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,body TEXT,PRIMARY KEY(scope,kind,id));
CREATE TABLE replica_changes(cursor INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,body TEXT);
CREATE INDEX replica_scope_cursor ON replica_changes(scope,cursor);
CREATE TABLE replica_receipts(scope TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,operation_id));
CREATE TABLE replica_imports(scope TEXT PRIMARY KEY,digest TEXT NOT NULL,source TEXT NOT NULL);
CREATE TABLE replica_generations(scope TEXT PRIMARY KEY,generation TEXT NOT NULL);
CREATE TABLE workspace_snapshots(scope TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE legacy_exports(scope TEXT PRIMARY KEY,body TEXT);
CREATE TABLE replica_history_adoptions(scope TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,request_id));`;
function legacy(filename, state) {
  const db = new DatabaseSync(filename); db.exec(v1Schema);
  db.prepare('INSERT INTO replica_generations VALUES(?,?)').run('Synthetic', '10000000-0000-4000-8000-000000000001');
  if (state) {
    db.prepare('INSERT INTO workspace_snapshots VALUES(?,?)').run('Synthetic', JSON.stringify(state));
    db.prepare('INSERT INTO legacy_exports VALUES(?,?)').run('Synthetic', null);
    for (const kind of ['task','goal','idea']) for (const value of state[`${kind}s`] ?? []) {
      db.prepare('INSERT INTO replica_records VALUES(?,?,?,?,?,?)').run('Synthetic',kind,value.id,19,0,canonicalJson(value));
      db.prepare('INSERT INTO replica_changes(scope,kind,id,revision,deleted,body) VALUES(?,?,?,?,?,?)').run('Synthetic',kind,value.id,19,0,canonicalJson(value));
    }
  }
  db.exec("UPDATE sqlite_sequence SET seq=101 WHERE name='replica_changes'");
  return db;
}
const envelope = () => ({ schema: 1, profile: 'Synthetic', revision: 7,
  tasks: [JSON.parse('{"title":"Café fixture","id":"T-B","version":71,"z":null,"a":[],"__proto__":{"retained":true}}'), { id: 'T-A', title: 'Second' }],
  goals: [], ideas: [], events: [{ id: 'duplicate', z: 1, a: 2 }, { id: 'duplicate' }],
  requests: [{ id: 'duplicate', command: 'opaque first' }, { id: 'duplicate', command: 'opaque second' }],
  councilSessions: null, auxiliary: { z: { revision: 6, nested: [null, false, 0] }, a: null },
  storage: { contract: 'synthetic-native-import' }, unknown: { b: 1, a: 2 } });

function persistedRows(db) {
  return Object.fromEntries(['workspace_roots','workspace_fields','workspace_items','workspace_auxiliary',
    'replica_records','replica_changes','replica_receipts','replica_generations','replica_imports',
    'replica_history_adoptions','legacy_exports','sqlite_sequence'].map(name=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
async function descriptorFixture(t) {
  const root=await fixture(t),store=new Store(root),state=await store.read('Synthetic');
  state.ideas=[{id:'I-1',title:'Original',status:'inbox',version:1},{id:'I-2',title:'Second',status:'inbox',version:1}];
  state.events=[{id:'event',detail:'Original event'}];state.requests=[{id:'retained',command:'opaque'}];
  state.auxiliary={fixture:{revision:0,text:'Original'}};
  await store.restoreSnapshot('Synthetic',state);
  return {root,store,db:await store.openDatabase(await store.directory('Synthetic'))};
}
function corruptDescriptor(db,defect) {
  if(defect==='missing-ideas')db.exec("DELETE FROM workspace_fields WHERE name='ideas'");
  if(defect==='wrong-kind')db.exec("UPDATE workspace_fields SET storage_kind='value',value_json='[]' WHERE name='ideas'");
  if(defect==='occupied-next')db.exec("UPDATE workspace_fields SET next_slot=0 WHERE name='ideas'");
  if(defect==='negative-next')db.exec("UPDATE workspace_fields SET next_slot=-1 WHERE name='ideas'");
  if(defect==='fractional-next')db.exec("UPDATE workspace_fields SET next_slot=2.5 WHERE name='ideas'");
  if(defect==='missing-events')db.exec("DELETE FROM workspace_fields WHERE name='events'");
  if(defect==='missing-auxiliary')db.exec("DELETE FROM workspace_fields WHERE name='auxiliary'");
}
for(const defect of ['missing-ideas','wrong-kind','occupied-next','negative-next','fractional-next','missing-events','missing-auxiliary'])test(`descriptor ${defect} rejects reads, callbacks and export without any publication`,async t=>{
  const f=await descriptorFixture(t);t.after(()=>f.db.close());corruptDescriptor(f.db.db,defect);
  const before=persistedRows(f.db.db),corrupt=error=>error.code==='storage-corrupt'&&error.status===503;
  assert.throws(()=>f.db.snapshot('Synthetic'),corrupt);
  assert.throws(()=>f.db.record('Synthetic','idea','I-1'),corrupt);
  await assert.rejects(f.store.read('Synthetic'),corrupt);
  await assert.rejects(f.store.readAuxiliary('Synthetic','fixture'),corrupt);
  await assert.rejects(hasWorkspaceSnapshot(path.join(await f.store.directory('Synthetic'),'core.sqlite3'),'Synthetic'),corrupt);
  let preflights=0,reducers=0;f.store.beforeCommand=()=>{preflights++;};
  const command={requestId:randomUUID(),expectedRevision:0,action:'idea.create',payload:{fields:{title:'Must not commit'}}};
  await assert.rejects(f.store.command('Synthetic',command),corrupt);
  await assert.rejects(f.store.transact('Synthetic',{...command,requestId:randomUUID()},()=>{reducers++;return{};}),corrupt);
  await assert.rejects(f.store.sync('Synthetic',{operationId:randomUUID(),id:randomUUID(),kind:'idea',action:'create',expectedRevision:0,value:{title:'Must not commit'}}),corrupt);
  const output=path.join(f.root,'rejected-export.sqlite3');assert.throws(()=>f.db.exportV1(output),corrupt);
  await assert.rejects(access(output),error=>error.code==='ENOENT');
  assert.equal(preflights,0);assert.equal(reducers,0);
  assert.deepEqual(persistedRows(f.db.db),before,'Rejected calls must not change revision, live rows, logs, receipt or cursor allocation');
});

for(const defect of ['missing-ideas','occupied-next'])test(`descriptor ${defect} introduced during held preflight rejects before the trusted reducer`,async t=>{
  const f=await descriptorFixture(t);t.after(()=>f.db.close());let enter,release,preflights=0,reducers=0;
  const ready=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.store.beforeCommand=async()=>{preflights++;enter();await gate;};
  const held=f.store.transact('Synthetic',{requestId:randomUUID(),expectedRevision:0,action:'synthetic.probe'},()=>{reducers++;return{};});
  await ready;corruptDescriptor(f.db.db,defect);const before=persistedRows(f.db.db);release();
  await assert.rejects(held,error=>error.code==='storage-corrupt');
  assert.equal(preflights,1);assert.equal(reducers,0);assert.deepEqual(persistedRows(f.db.db),before);
});

for(const transport of ['command','sync'])for(const defect of ['missing-ideas','occupied-next','moved-replacement'])test(`${transport} publication fences concurrent ${defect} and preserves the exact post-corruption baseline`,async t=>{
  const f=await descriptorFixture(t);t.after(()=>f.db.close());const open=f.store.openDatabase.bind(f.store);let before,injections=0;
  f.store.openDatabase=async directory=>{
    const db=await open(directory),method=transport==='command'?'commitCommand':'commitSync',commit=db[method].bind(db);
    db[method]=(...args)=>{
      injections++;
      if(defect==='moved-replacement'){
        db.db.exec("BEGIN IMMEDIATE; UPDATE workspace_items SET slot=-slot-1 WHERE collection='ideas'; UPDATE workspace_items SET slot=CASE slot WHEN -1 THEN 1 ELSE 0 END WHERE collection='ideas'; COMMIT");
      }else corruptDescriptor(db.db,defect);
      before=persistedRows(db.db);return commit(...args);
    };return db;
  };
  const command={requestId:randomUUID(),expectedRevision:0,action:defect==='moved-replacement'?'idea.update':'idea.create',payload:defect==='moved-replacement'?{id:'I-1',fields:{title:'Must not replace'}}:{fields:{title:'Must not append'}}};
  const attempt=transport==='command'?f.store.command('Synthetic',command):f.store.sync('Synthetic',{
    operationId:randomUUID(),kind:'idea',id:defect==='moved-replacement'?'I-1':randomUUID(),
    action:defect==='moved-replacement'?'update':'create',expectedRevision:defect==='moved-replacement'?1:0,value:{title:'Must not publish'},
  });
  await assert.rejects(attempt,error=>error.code==='storage-corrupt');
  assert.equal(injections,1);assert.deepEqual(persistedRows(f.db.db),before);
});

test('an APPEND delta cannot overwrite an occupied slot even when the persisted descriptors remain valid',async t=>{
  const f=await descriptorFixture(t);t.after(()=>f.db.close());const view=f.db.readWorkspace('Synthetic'),next=structuredClone(view.state),j=new MutationJournal(view.layout);
  const command={requestId:randomUUID(),expectedRevision:0,action:'idea.create',payload:{fields:{title:'Attempted'}}},serialized=canonicalJson(command);
  next.revision++;const idea={id:'NEW',title:'Attempted'};next.ideas.push(idea);j.append('ideas',idea);
  const receipt={id:command.requestId,command:serialized};next.requests.push(receipt);j.append('requests',receipt);
  const delta=j.prepare(next);delta.items.find(item=>item.collection==='ideas').slot=0;
  const before=persistedRows(f.db.db);
  assert.throws(()=>f.db.commitCommand('Synthetic',{expectedRevision:0,generation:f.db.generation('Synthetic'),requestId:command.requestId,command:serialized},delta),error=>error.code==='storage-corrupt'&&/occupied/.test(error.message));
  assert.deepEqual(persistedRows(f.db.db),before);
});

test('exhausted collection allocation cannot commit an unsafe next slot',async t=>{
  const f=await descriptorFixture(t);t.after(()=>f.db.close());
  f.db.db.prepare("UPDATE workspace_fields SET next_slot=? WHERE name='ideas'").run(Number.MAX_SAFE_INTEGER);
  const before=persistedRows(f.db.db);
  await assert.rejects(f.store.command('Synthetic',{requestId:randomUUID(),expectedRevision:0,action:'idea.create',payload:{fields:{title:'Exhausted append'}}}),error=>error.code==='storage-corrupt');
  assert.deepEqual(persistedRows(f.db.db),before);
  assert.equal(f.db.snapshot('Synthetic').ideas.length,2,'A safe exhausted counter remains readable');
});

test('independent processes can initialize the same new format-2 file without conflicting bootstrap or history identities',{timeout:10000},async t=>{
  const root=await fixture(t),filename=path.join(root,'Synthetic','state','core.sqlite3');
  const script=`import {Store} from ${JSON.stringify(new URL('../server/store.ts',import.meta.url).href)};
    process.on('message',async()=>{try{const state=await new Store(process.argv[1]).read('Synthetic');process.send({generation:state.syncGeneration});process.disconnect();}catch(error){process.stderr.write(error.stack);process.exit(1);}});process.send('ready');`;
  const children=Array.from({length:4},()=>spawn(process.execPath,['--input-type=module','-e',script,root],{stdio:['ignore','ignore','pipe','ipc']}));
  t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill();});
  const generations=[];
  const exits=children.map(child=>new Promise((resolve,reject)=>{
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('message',message=>{if(message && typeof message==='object')generations.push(message.generation);});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(stderr || `Child exited ${code}`)));
  }));
  await Promise.all(children.map(child=>new Promise(resolve=>child.on('message',message=>{if(message==='ready')resolve();}))));
  children.forEach(child=>child.send('start'));await Promise.all(exits);
  assert.equal(generations.length,4);assert.equal(new Set(generations).size,1);
  const db=new SqliteReplica(filename);t.after(()=>db.close());
  assert.equal(db.format,2);assert.equal(db.snapshot('Synthetic'),undefined);
});

for (const defect of ['raw-divergence','malformed-raw','malformed-body','missing-raw','identity-pair','primitive-entity','membership']) test(`normalized readers and export reject ${defect} without publishing`, async t => {
  const root=await fixture(t),store=new Store(root),state=await store.read('Synthetic');
  state.tasks=[{title:'Original',id:'T-1',status:'todo',version:1,z:1,a:2}];
  await store.restoreSnapshot('Synthetic',state);
  const filename=path.join(await store.directory('Synthetic'),'core.sqlite3'),db=new SqliteReplica(filename);
  if(defect==='raw-divergence')db.db.prepare('UPDATE replica_records SET raw_body=?').run(JSON.stringify({...state.tasks[0],title:'Different'}));
  if(defect==='malformed-raw')db.db.exec("UPDATE replica_records SET raw_body='{broken'");
  if(defect==='malformed-body')db.db.exec("UPDATE replica_records SET body='{broken'");
  if(defect==='missing-raw')db.db.exec('UPDATE replica_records SET raw_body=NULL');
  if(defect==='identity-pair'){
    const wrong={...state.tasks[0],id:'Other'};
    db.db.prepare('UPDATE replica_records SET raw_body=?,body=?').run(JSON.stringify(wrong),canonicalJson(wrong));
  }
  if(defect==='primitive-entity')db.db.exec("UPDATE replica_records SET raw_body='3',body='3'");
  if(defect==='membership')db.db.exec("DELETE FROM workspace_items WHERE entity_kind='task'");
  db.close();const reopened=new SqliteReplica(filename);t.after(()=>reopened.close());
  const corrupt=error=>error.status===503 && error.code==='storage-corrupt';
  assert.throws(()=>reopened.snapshot('Synthetic'),corrupt);
  assert.throws(()=>reopened.record('Synthetic','task','T-1'),corrupt);
  await assert.rejects(new Store(root).read('Synthetic'),corrupt);
  let callbacks=0;store.beforeCommand=()=>{callbacks++;};
  await assert.rejects(store.command('Synthetic',{requestId:randomUUID(),expectedRevision:0,action:'task.update',payload:{id:'T-1',fields:{title:'Attempted'}}}),corrupt);
  assert.equal(callbacks,0);
  assert.equal(reopened.db.prepare('SELECT revision FROM workspace_roots').get().revision,0);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM workspace_items WHERE collection IN ('events','requests','strategicAudit')").get().n,0);
  const output=path.join(root,'must-not-publish.sqlite3');
  assert.throws(()=>reopened.exportV1(output),corrupt);
  await assert.rejects(access(output),error=>error.code==='ENOENT');
});

test('raw property order remains authoritative while canonical wire order remains a valid projection',async t=>{
  const root=await fixture(t),filename=path.join(root,'state.sqlite3'),db=new SqliteReplica(filename);t.after(()=>db.close());
  const task={title:'Original',id:'T-1',z:{z:1,a:2},a:null};
  db.initializeSnapshot('Synthetic',{revision:0,tasks:[task]});
  const raw=db.snapshot('Synthetic').tasks[0],wire=db.record('Synthetic','task','T-1').value;
  assert.equal(JSON.stringify(raw),JSON.stringify(task));
  assert.notEqual(JSON.stringify(raw),JSON.stringify(wire));
  assert.equal(canonicalJson(raw),canonicalJson(wire));
  db.exportV1(path.join(root,'valid-export.sqlite3'));
});

test('export validates standalone primitive and tombstone projection pairs as well as workspace members',async t=>{
  for(const tombstone of [false,true]){
    const root=await fixture(t),db=new SqliteReplica(path.join(root,'state.sqlite3'));t.after(()=>db.close());
    const op={operationId:randomUUID(),kind:'task',id:'primitive',action:'create',expectedRevision:0,value:3};
    db.apply('Standalone',op,()=>3);
    if(tombstone)db.apply('Standalone',{...op,operationId:randomUUID(),action:'delete',expectedRevision:1},()=>null);
    db.db.exec("UPDATE replica_records SET raw_body='4'");
    assert.throws(()=>db.record('Standalone','task','primitive'),error=>error.code==='storage-corrupt');
    assert.throws(()=>db.exportV1(path.join(root,'corrupt-export.sqlite3')),error=>error.code==='storage-corrupt');
  }
});

test('v1 opens without migration; explicit conversion preserves bytes, order, receipts, feed and cursor allocation', async t => {
  const root = await fixture(t), filename = path.join(root, 'v1.sqlite3'), state = envelope();
  const old = legacy(filename, state);
  old.prepare('INSERT INTO replica_receipts VALUES(?,?,?,?)').run('Synthetic','receipt','digest','{ "opaque": true }');
  old.prepare('INSERT INTO replica_imports VALUES(?,?,?)').run('Synthetic','digest','{ "original": [1, 2] }');
  const feed = old.prepare('SELECT * FROM replica_changes ORDER BY cursor').all(); old.close();
  const db = new SqliteReplica(filename); t.after(() => db.close());
  assert.equal(db.format, 1);
  assert.throws(() => db.saveSnapshot('Synthetic',state), error => error.code === 'storage-migration-required');
  assert.equal(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_roots'").get(), undefined);
  assert.throws(() => db.migrateWorkspaceFormat({ ...admission, backupVerified: false }), /backup/);
  assert.equal(db.migrateWorkspaceFormat(admission), true);
  assert.equal(db.migrateWorkspaceFormat(admission), false);
  assert.equal(JSON.stringify(db.snapshot('Synthetic')), JSON.stringify(state));
  assert.deepEqual(db.db.prepare('SELECT * FROM replica_changes ORDER BY cursor').all(), feed);
  assert.equal(db.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='replica_changes'").get().seq, 101);
  assert.equal(db.db.prepare('SELECT result FROM replica_receipts').get().result, '{ "opaque": true }');
  assert.equal(db.db.prepare('SELECT source FROM replica_imports').get().source, '{ "original": [1, 2] }');
  assert.equal(db.db.prepare('SELECT body FROM workspace_snapshot_exports_v1').get().body, JSON.stringify(state));
  assert.throws(() => db.db.exec("UPDATE workspace_snapshot_exports_v1 SET body='{}'"), /immutable/);
  assert.throws(() => db.db.exec('INSERT OR IGNORE INTO replica_schema VALUES(1)'), /compatible runtime/);
  await chmod(filename, 0o600);
  assert.equal(await hasWorkspaceSnapshot(filename,'Synthetic','synthetic-native-import'), true);
  assert.equal(await hasWorkspaceSnapshot(filename,'Synthetic','wrong-contract'), false);
});

for (const defect of ['missing-record','extra-record','divergent','partial','storage-failure']) test(`migration rejects ${defect} atomically`, async t => {
  const filename = path.join(await fixture(t), 'v1.sqlite3'), old = legacy(filename,envelope());
  if (defect === 'missing-record') old.exec("DELETE FROM replica_records WHERE id='T-A'");
  if (defect === 'extra-record') old.exec("INSERT INTO replica_records VALUES('Synthetic','task','extra',1,0,'{}')");
  if (defect === 'divergent') old.exec("UPDATE replica_records SET body='{}' WHERE id='T-A'");
  if (defect === 'partial') old.exec('CREATE TABLE workspace_roots(scope TEXT)');
  if (defect === 'storage-failure') old.exec("CREATE TRIGGER fail_migration BEFORE UPDATE ON replica_records BEGIN SELECT RAISE(ABORT,'injected migration failure'); END");
  const bytes = old.prepare('SELECT body FROM workspace_snapshots').get().body; old.close();
  const db = new SqliteReplica(filename); t.after(() => db.close());
  assert.throws(() => db.migrateWorkspaceFormat(admission), /diverge|membership|already exists|injected/);
  assert.equal(db.format,1);
  assert.equal(db.db.prepare('SELECT version FROM replica_schema').get().version,1);
  assert.equal(db.db.prepare('SELECT body FROM workspace_snapshots').get().body,bytes);
  assert.equal(db.db.prepare('PRAGMA table_info(replica_records)').all().some(row => row.name === 'raw_body'),false);
});

test('trusted bulk replacement retains explicit root, auxiliary and collection reorders, removal, null and duplicate values', async t => {
  const db = new SqliteReplica(path.join(await fixture(t),'state.sqlite3')); t.after(()=>db.close());
  const first = envelope(); db.importWorkspace('Synthetic',first,{public:true});
  const head = db.head('Synthetic');
  const second = { auxiliary:first.auxiliary, unknown:first.unknown, ...first, tasks:[...first.tasks].reverse(), events:[null,...first.events].reverse() };
  second.auxiliary={a:null,z:first.auxiliary.z};
  delete second.unknown;
  second.extra = [null,false,0];
  db.saveSnapshot('Synthetic',second,7);
  assert.equal(Object.keys(db.snapshot('Synthetic'))[0],'auxiliary');
  assert.equal(JSON.stringify(db.snapshot('Synthetic')),JSON.stringify(second));
  assert.equal(db.head('Synthetic'),head,'Reorder cannot manufacture canonical record changes');
  const third = {...second,auxiliary:null,events:null};
  db.saveSnapshot('Synthetic',third,7);
  assert.equal(JSON.stringify(db.snapshot('Synthetic')),JSON.stringify(third));
  const fourth = {...third,auxiliary:{fresh:{revision:1}},events:[]};
  db.saveSnapshot('Synthetic',fourth,7);
  assert.equal(JSON.stringify(db.snapshot('Synthetic')),JSON.stringify(fourth));
  for(const historical of ['opaque historical value',[],42,false,true]){
    const opaque={...fourth,auxiliary:historical};db.saveSnapshot('Synthetic',opaque,7);
    assert.equal(JSON.stringify(db.snapshot('Synthetic')),JSON.stringify(opaque));
    db.saveSnapshot('Synthetic',fourth,7);
    assert.equal(JSON.stringify(db.snapshot('Synthetic')),JSON.stringify(fourth));
  }
});

for (const format of [1,2]) test(`backup and isolated restore preserve format ${format} workspace bytes and cursor allocation`, async t => {
  const root = await fixture(t), filename = path.join(root,'state.sqlite3'), old = legacy(filename,envelope());old.close();
  const db = new SqliteReplica(filename);
  if (format === 2) db.migrateWorkspaceFormat(admission);
  const before = JSON.stringify(db.snapshot('Synthetic')); db.close();
  const archive = await createDailyBackup({root,databases:['state.sqlite3'],resources:[],recovery:{profiles:['Synthetic']}},path.join(root,'backups'),new Date('2026-10-30T12:00:00Z'));
  const target = path.join(root,'restored');await restoreBackup(archive,target);
  const restored = new SqliteReplica(path.join(target,'state.sqlite3'));t.after(()=>restored.close());
  assert.equal(restored.format,format);
  assert.equal(JSON.stringify(restored.snapshot('Synthetic')),before);
  assert.equal(restored.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='replica_changes'").get().seq,101);
});

test('ordinary command and keyed auxiliary preparation do not parse unrelated log or auxiliary bodies', async t => {
  const root = await fixture(t),store = new Store(root),state = await store.read('Synthetic');
  const marker = 'synthetic-unrelated-body-marker';
  state.events = [{id:'old-event',opaque:marker}];state.requests=[{id:'old-request',command:marker}];
  state.strategicAudit=[{id:'old-audit',opaque:marker}];state.preferenceHistory=[{opaque:marker}];
  state.auxiliary={unrelated:{opaque:marker},fixture:{revision:0,text:'initial'}};
  await store.restoreSnapshot('Synthetic',state);
  const originalOpen=store.openDatabase.bind(store),parse=JSON.parse;
  let watching=false;
  store.openDatabase=async directory=>{
    const db=await originalOpen(directory),commit=db.commitCommand.bind(db);
    db.commitCommand=(...args)=>{const result=commit(...args);watching=false;return result;};return db;
  };
  JSON.parse=(text,...args)=>{if(watching && typeof text==='string' && text.includes(marker))throw Error('Parsed unrelated body during preparation');return parse(text,...args);};
  try{
    watching=true;
    await store.command('Synthetic',{requestId:randomUUID(),expectedRevision:0,action:'task.create',payload:{fields:{title:'Public task'}}});
    const auxiliary=new AuxiliaryState({store:async()=>store,scope:'Synthetic',key:'fixture',initial:()=>({revision:0,text:''}),validate:value=>value,legacyFile:path.join(root,'absent.json')});
    watching=true;await auxiliary.change(value=>{value.revision++;value.text='changed';});
  }finally{JSON.parse=parse;watching=false;}
  assert.deepEqual((await store.read('Synthetic')).auxiliary.unrelated,state.auxiliary.unrelated);
});

test('pure sync preparation retries a real root CAS miss but does not repeat an evidence callback', async t => {
  for(const evidence of [false,true]){
    const store=new Store(path.join(await fixture(t),String(evidence))),original=store.openDatabase.bind(store);
    let injected=false,calls=0;
    if(evidence)store.beforeCommand=()=>{calls++;};
    store.openDatabase=async directory=>{
      const db=await original(directory),commit=db.commitSync.bind(db);
      db.commitSync=(...args)=>{
        if(!injected){injected=true;db.db.prepare('UPDATE workspace_roots SET revision=revision+1 WHERE scope=?').run('Synthetic');}
        return commit(...args);
      };return db;
    };
    const op={operationId:randomUUID(),id:randomUUID(),kind:'task',action:'create',expectedRevision:0,value:{title:'Saved intent'}};
    if(evidence)await assert.rejects(store.sync('Synthetic',op),error=>error.code==='workspace-cas');
    else assert.equal((await store.sync('Synthetic',op)).status,'accepted');
    const db=await original(await store.directory('Synthetic'));
    assert.equal(db.hasReceipt('Synthetic',op.operationId),!evidence);
    assert.equal(db.snapshot('Synthetic').tasks.length,evidence?0:1);db.close();
    assert.equal(calls,evidence?1:0);
  }
});

test('persistent root contention returns a transient CAS failure without a durable operation receipt', async t => {
  const store=new Store(await fixture(t)),original=store.openDatabase.bind(store);let attempts=0;
  store.openDatabase=async directory=>{
    const db=await original(directory),commit=db.commitSync.bind(db);
    db.commitSync=(...args)=>{attempts++;db.db.prepare('UPDATE workspace_roots SET revision=revision+1 WHERE scope=?').run('Synthetic');return commit(...args);};return db;
  };
  const op={operationId:randomUUID(),id:randomUUID(),kind:'task',action:'create',expectedRevision:0,value:{title:'Retained intent'}};
  await assert.rejects(store.sync('Synthetic',op),error=>error.code==='workspace-cas');
  assert.ok(attempts>1);
  const db=await original(await store.directory('Synthetic'));t.after(()=>db.close());
  assert.equal(db.hasReceipt('Synthetic',op.operationId),false);
  assert.equal(db.snapshot('Synthetic').tasks.length,0);
  assert.equal(db.snapshot('Synthetic').events.length,0);
});

test('record-only v1 scopes preserve primitive values and do not become initialized workspaces', async t => {
  const filename = path.join(await fixture(t),'v1.sqlite3'), old = legacy(filename);
  for (const [index,value] of [null,3,'text',[1,2],false].entries()) old.prepare('INSERT INTO replica_records VALUES(?,?,?,?,?,?)').run('Synthetic','task',String(index),index+1,0,JSON.stringify(value));
  old.close(); const db = new SqliteReplica(filename); t.after(() => db.close());
  db.migrateWorkspaceFormat(admission);
  assert.equal(db.snapshot('Synthetic'),undefined);
  assert.throws(() => db.initializeSnapshot('Synthetic',{revision:0,tasks:[]}),/Record-only/);
  assert.deepEqual(db.db.prepare('SELECT raw_body FROM replica_records ORDER BY id').all().map(row => JSON.parse(row.raw_body)),[null,3,'text',[1,2],false]);
  assert.equal(db.initializeSnapshot('ExplicitEmpty',{revision:0,tasks:[],events:[],requests:[]}),true);
  assert.equal(db.snapshot('ExplicitEmpty').revision,0);
});

test('malformed standalone v1 records fail migration before the format marker changes',async t=>{
  const filename=path.join(await fixture(t),'v1.sqlite3'),old=legacy(filename);
  old.exec("INSERT INTO replica_records VALUES('Standalone','task','primitive',1,0,'{broken')");old.close();
  const db=new SqliteReplica(filename);t.after(()=>db.close());
  assert.throws(()=>db.migrateWorkspaceFormat(admission),error=>error.code==='storage-corrupt');
  assert.equal(db.format,1);
  assert.equal(db.db.prepare('SELECT version FROM replica_schema').get().version,1);
  assert.equal(db.db.prepare('PRAGMA table_info(replica_records)').all().some(row=>row.name==='raw_body'),false);
});

test('isolated v1 export retains normalized writes and allocation, and refuses overwrite', async t => {
  const root = await fixture(t), filename = path.join(root,'v1.sqlite3'), old = legacy(filename,envelope()); old.close();
  const db = new SqliteReplica(filename); t.after(() => db.close()); db.migrateWorkspaceFormat(admission);
  const next = db.snapshot('Synthetic'); next.revision++; next.tasks[0].title = 'After conversion';
  next.events.push({ id: 'new-event', detail: 'public' }); next.auxiliary.z.revision++;
  db.saveSnapshot('Synthetic',next,7);
  const output = path.join(root,'rollback.sqlite3'); db.exportV1(output);
  assert.throws(() => db.exportV1(output), /EEXIST/);
  const reopened = new SqliteReplica(output); t.after(() => reopened.close());
  assert.equal(reopened.format,1);
  assert.equal(JSON.stringify(reopened.snapshot('Synthetic')),JSON.stringify(db.snapshot('Synthetic')));
  assert.deepEqual(reopened.changes('Synthetic'),db.changes('Synthetic'));
  assert.equal(reopened.generation('Synthetic'),db.generation('Synthetic'));
  assert.equal(reopened.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='replica_changes'").get().seq,102);
  assert.equal(db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_snapshots'").get(),undefined);
});

for (const transport of ['command','sync']) for (const failedDependency of [false,true]) test(`${transport} replays a receipt committed during held ${failedDependency ? 'failed' : 'successful'} preflight despite advanced workspace revision`, async t => {
  const root = await fixture(t), store = new Store(root), peer = new Store(root);
  let entered, release, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const initial = await store.replicaState('Synthetic');
  store.beforeCommand = async () => { calls++; entered(); await gate; if(failedDependency)throw Error('Evidence no longer available'); };
  const input = transport === 'command' ? { requestId: randomUUID(), expectedRevision: 0, expectedGeneration: initial.syncGeneration, action: 'task.create', payload: { fields: { title: 'One intent' } } }
    : { operationId: randomUUID(), kind: 'task', id: randomUUID(), action: 'create', expectedRevision: 0, value: { title: 'One intent' } };
  const held = transport === 'command' ? store.command('Synthetic',input) : store.sync('Synthetic',input,{generation:initial.syncGeneration});
  await ready;
  const won = await peer[transport]('Synthetic',input);
  const current = await peer.read('Synthetic');
  await peer.command('Synthetic',{ requestId: randomUUID(), expectedRevision: current.revision, action:'goal.create',payload:{fields:{title:'Unrelated advance'}} });
  const before = await peer.read('Synthetic');
  release(); const replay = await held;
  if (transport === 'sync') assert.deepEqual(replay,won);
  assert.equal(calls,1);
  assert.deepEqual(await peer.read('Synthetic'),before);
});

test('one ordinary record edit writes a bounded set of rows regardless of unrelated history and auxiliary bodies', async t => {
  const measurements = [],payloadBytes=[];
  for (const count of [1,1000,10000]) {
    const root = path.join(await fixture(t),String(count)), store = new Store(root), state = await store.read('Synthetic');
    state.tasks = [{ id:'target',title:'Target',status:'todo',version:1 }, ...Array.from({length:count},(_,i)=>({id:`T-${i}`,title:`Task ${i}`,status:'todo'}))];
    state.events = Array.from({length:count},(_,i)=>({id:`E-${i}`,opaque:'history'.repeat(20)}));
    state.requests = state.events.map(row=>({id:row.id,command:'opaque'}));
    state.auxiliary = { unrelated: { body:'retained'.repeat(count) } };
    await store.restoreSnapshot('Synthetic',state);
    const db = await store.openDatabase(await store.directory('Synthetic'));
    // Abort any write to unrelated rows, then count actual authoritative writes.
    db.db.exec(`CREATE TABLE test_writes(name TEXT,bytes INTEGER);
      CREATE TRIGGER no_unrelated_record BEFORE UPDATE ON replica_records WHEN OLD.id!='target' BEGIN SELECT RAISE(ABORT,'unrelated entity write'); END;
      CREATE TRIGGER no_auxiliary_write BEFORE UPDATE ON workspace_auxiliary BEGIN SELECT RAISE(ABORT,'unrelated auxiliary write'); END;`);
    for (const table of ['replica_records','replica_changes','workspace_roots','workspace_fields','workspace_items','workspace_auxiliary']) {
      const columns=db.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name);
      for (const event of ['INSERT','UPDATE','DELETE']) {
        const row=event==='DELETE'?'OLD':'NEW',bytes=columns.map(column=>`length(CAST(COALESCE(${row}.${column},'') AS BLOB))`).join('+');
        db.db.exec(`CREATE TRIGGER count_${table}_${event} AFTER ${event} ON ${table} BEGIN INSERT INTO test_writes VALUES('${table}',${bytes}); END`);
      }
    }
    db.close();
    await store.command('Synthetic',{requestId:randomUUID(),expectedRevision:0,action:'task.update',payload:{id:'target',fields:{title:'Changed'}}});
    const checked = await store.openDatabase(await store.directory('Synthetic'));
    measurements.push(checked.db.prepare('SELECT COUNT(*) AS n FROM test_writes').get().n);
    payloadBytes.push(checked.db.prepare('SELECT SUM(bytes) AS n FROM test_writes').get().n);
    assert.equal(checked.db.prepare("SELECT value_json FROM workspace_auxiliary WHERE name='unrelated'").get().value_json,JSON.stringify(state.auxiliary.unrelated));
    assert.equal(checked.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_snapshots'").get(),undefined);
    checked.close();
  }
  assert.deepEqual(measurements,[measurements[0],measurements[0],measurements[0]]);
  assert.ok(measurements[0] < 30,JSON.stringify(measurements));
  assert.ok(Math.max(...payloadBytes)-Math.min(...payloadBytes)<128,JSON.stringify(payloadBytes));
  t.diagnostic(JSON.stringify({unrelatedRecords:[1,1000,10000],changedRows:measurements,changedRowPayloadBytes:payloadBytes}));
});
