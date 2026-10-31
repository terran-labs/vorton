import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createCoreServer, attachWorkspaceLifecycle } from "../server/core-http.mjs";
import { WorkspaceHttpHost } from "../server/workspace-http-host.ts";
import { Store } from "../server/store.ts";

async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),"portable-http-"));
  // Keep HTTP admission tests independent of host-specific ancestor symlinks.
  const installationId = randomUUID();
  const app=createCoreServer({root,port:0,installationIdentity:async()=>installationId});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  app.hosts.add(new URL(base).host);app.allowed.add(base);
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(root,{recursive:true,force:true});});
  const session=await(await fetch(`${base}/api/session`)).json();
  const headers={Origin:base,"Content-Type":"application/json","X-Vorton-Session":session.token};
  return {root,base,headers,store:app.store};
}

test("changed local Store callbacks fail closed in HTTP while health stays available", async t => {
  const { base, store } = await fixture(t);
  let calls = 0;
  store.beforeCommand = async () => { calls++; };
  const response = await fetch(`${base}/api/lastresort/state`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "http-policy-changed");
  assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const before = await store.read("LastResort");
  await store.command("LastResort", { requestId: randomUUID(), expectedRevision: before.revision,
    action: "task.create", payload: { fields: { title: "Local callback still runs" } } });
  assert.equal(calls, 1);
});

test("legacy close returns the server and waits for worker and backup cleanup before callbacks", async () => {
  const server = http.createServer();
  let releaseWorker, releaseBackup, workerCalls = 0, backupCalls = 0, callbackCalls = 0;
  const worker = new Promise(resolve => { releaseWorker = resolve; });
  const backup = new Promise(resolve => { releaseBackup = resolve; });
  attachWorkspaceLifecycle(server, { close: () => { workerCalls++; return worker; } },
    { stop: () => { backupCalls++; return backup; } }, true);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const closed = new Promise((resolve, reject) => {
    assert.equal(server.close(error => { callbackCalls++; if (error) reject(error); else resolve(); }), server);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbackCalls, 0);
  releaseWorker(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbackCalls, 0);
  releaseBackup(); await closed;
  assert.equal(callbackCalls, 1); assert.equal(workerCalls, 1); assert.equal(backupCalls, 1);
  const again = await new Promise(resolve => server.close(resolve));
  assert.equal(again.code, "ERR_SERVER_NOT_RUNNING");
  assert.equal(workerCalls, 1); assert.equal(backupCalls, 1);
});

test("never-listened servers drain ready workers and borrowed servers retain parent ownership", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-worker-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = createCoreServer({ root, port: 0 });
  await app.ready();
  const error = await new Promise(resolve => app.server.close(resolve));
  assert.equal(error.code, "ERR_SERVER_NOT_RUNNING");
  await assert.rejects(app.ready(), /closing/);
  const borrowed = http.createServer(); let workers = 0, backups = 0;
  attachWorkspaceLifecycle(borrowed, { close: async () => { workers++; } }, { stop: async () => { backups++; } }, false);
  await new Promise(resolve => borrowed.close(resolve));
  assert.equal(workers, 0); assert.equal(backups, 1);
});

test("listen failure closes an already ready owned worker", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-worker-listen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const app = createCoreServer({ root, port: 0 });
  await app.ready();
  const failed = new Promise(resolve => app.server.once("error", resolve));
  app.server.listen(occupied.address().port, "127.0.0.1");
  assert.equal((await failed).code, "EADDRINUSE");
  await app.close();
  await assert.rejects(app.ready(), /closing/);
});

test("awaited application close stops the HTTP listener as well as its worker", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-worker-awaited-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = createCoreServer({ root, port: 0 });
  await app.ready();
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  assert.equal(app.server.listening, true);
  await app.close();
  assert.equal(app.server.listening, false);
  await assert.rejects(app.ready(), /closing/);
  await app.close();
});

test("cleanup failure is not hidden by a never-listened server's close error", async () => {
  const server = http.createServer(), failure = new Error("Worker outcome is uncertain");
  const close = attachWorkspaceLifecycle(server, { close: async () => { throw failure; } }, { stop: async () => {} }, true);
  await assert.rejects(close(), error => error === failure);
});
test("cleanup errors retain their origin even with the native not-running code", async () => {
  const server = http.createServer();
  const failure = Object.assign(new Error("Worker outcome is uncertain"), { code: "ERR_SERVER_NOT_RUNNING" });
  const close = attachWorkspaceLifecycle(server, { close: async () => { throw failure; } }, { stop: async () => {} }, true);
  await assert.rejects(close(), error => error === failure);
  await assert.rejects(close(), error => error === failure);
});

test("a stalled HTTP response bounds queued work and disconnect releases delivery", { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-slow-response-"));
  const store = new Store(root, ["Synthetic"]), state = await store.read("Synthetic");
  state.settings.syntheticPayload = "x".repeat(16 * 1024 * 1024);
  await store.restoreSnapshot("Synthetic", state);
  const host = new WorkspaceHttpHost({ targets: [{ id: "test", kind: "portable", root, profiles: ["Synthetic"] }], maximumQueuedJobs: 1 });
  const app = createCoreServer({ root, port: 0, enabledProfiles: ["Synthetic"], defaultPath: "/synthetic/bridge",
    installationIdentity: async () => "synthetic-slow-response", workspace: { host, target: "test" } });
  let slowRequest, slowResponse;
  const queuedAbort = new AbortController();
  t.after(async () => {
    queuedAbort.abort(); slowResponse?.destroy(); slowRequest?.destroy();
    await app.close(); await host.close(); await rm(root, { recursive: true, force: true });
  });
  await app.ready();
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.hosts.add(new URL(base).host); app.allowed.add(base);
  let delivered = false;
  const slowClosed = new Promise(resolve => app.server.prependOnceListener("request", (_request, response) => {
    response.once("finish", () => { delivered = true; });
    response.once("close", resolve);
  }));
  await new Promise((resolve, reject) => {
    slowRequest = http.get(base + "/api/synthetic/state", { headers: { "Accept-Encoding": "identity" } }, response => {
      slowResponse = response; response.pause(); resolve();
    });
    slowRequest.on("error", reject);
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(delivered, false, "fixture must hold actual socket delivery, not just a synthetic permit");
  let queuedClosed;
  const arrived = new Promise(resolve => app.server.once("request", (_request, response) => {
    queuedClosed = new Promise(closed => response.once("close", closed));
    setImmediate(resolve);
  }));
  const queued = fetch(base + "/api/synthetic/state?view=replica", { signal: queuedAbort.signal });
  // Wait for the queued HTTP request to arrive before probing the single queue slot.
  await arrived;
  const busy = await fetch(base + "/api/synthetic/state?view=replica");
  assert.equal(busy.status, 503); assert.equal((await busy.json()).code, "http-worker-busy");
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal(delivered, false);
  queuedAbort.abort(); await assert.rejects(queued, error => error.name === "AbortError");
  await queuedClosed;
  slowResponse.destroy(); slowRequest.destroy();
  await slowClosed;
  const resumed = await fetch(base + "/api/synthetic/state?view=replica");
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).revision, state.revision);
});
test("portable mutations reject foreign origins, forged sessions, malformed bodies, and stale revisions",async t=>{
  const {base,headers,store}=await fixture(t);
  const command={requestId:randomUUID(),expectedRevision:0,action:"goal.create",payload:{fields:{title:"Controlled fixture"}}};
  const post=(body,overrides={})=>fetch(`${base}/api/lastresort/command`,{method:"POST",headers:{...headers,...overrides},body});
  assert.equal((await post(JSON.stringify(command),{Origin:"https://foreign.example"})).status,403);
  assert.equal((await post(JSON.stringify(command),{"X-Vorton-Session":"wrong"})).status,403);
  for(const body of ["{","null","[]"])assert.equal((await post(body)).status,400);
  const initial=await(await fetch(`${base}/api/lastresort/state`)).json();
  for (const expectedGeneration of [undefined, null, "", 1]) {
    const legacy = await post(JSON.stringify({ ...command, expectedGeneration }));
    assert.equal(legacy.status, 409); assert.equal((await legacy.json()).code, "history-required");
  }
  assert.equal((await(await fetch(`${base}/api/lastresort/state`)).json()).goals.length, 0);
  const stale=await post(JSON.stringify({...command,expectedGeneration:randomUUID()}));
  assert.equal(stale.status,409);assert.equal((await stale.json()).code,"history-changed");
  command.expectedGeneration=initial.syncGeneration;
  assert.equal((await post(JSON.stringify(command))).status,200);
  assert.equal((await post(JSON.stringify(command))).status,200,"Identical retries remain idempotent");
  assert.equal((await post(JSON.stringify({...command,requestId:randomUUID()}))).status,409);
  const state=await(await fetch(`${base}/api/lastresort/state`)).json();
  assert.equal(state.goals.length,1);
  const adoption = await store.adoptHistory("LastResort", { requestId: randomUUID(), expectedGeneration: initial.syncGeneration, expectedRevision: state.revision });
  const current = await store.read("LastResort");
  for (const expectedGeneration of [undefined, initial.syncGeneration]) {
    const priorHistory = await post(JSON.stringify({ ...command, requestId: randomUUID(), expectedRevision: current.revision, expectedGeneration }));
    assert.equal(priorHistory.status, 409);
    assert.equal((await priorHistory.json()).code, expectedGeneration ? "history-changed" : "history-required");
  }
  assert.deepEqual(await store.read("LastResort"), current);
  assert.equal(current.syncGeneration, adoption.generation);
  assert.equal("requests" in state,false);
  assert.equal((await fetch(`${base}/api/lastresort/state`,{headers:{"Sec-Fetch-Site":"cross-site"}})).status,403);
});

test("synchronization validates admission and generation, replays twenty lost acknowledgements, and serves ordered changes", async t => {
  const { base, headers } = await fixture(t);
  const initial = await (await fetch(`${base}/api/lastresort/changes`)).json();
  assert.equal(initial.protocol, "vorton.sync.v1");
  assert.equal(initial.cursor, 0);
  assert.deepEqual(initial.changes, []);
  const operation = index => ({ operationId: randomUUID(), id: randomUUID(), kind: "task", action: "create", expectedRevision: 0, value: { title: `Queued task ${index}` } });
  const request = op => ({ protocol: initial.protocol, generation: initial.generation, operation: op });
  const post = (input, override = {}) => fetch(`${base}/api/lastresort/sync`, { method: "POST", headers: { ...headers, ...override }, body: JSON.stringify(input) });
  const first = request(operation(1));
  assert.equal((await post(first, { Origin: "https://foreign.example" })).status, 403);
  assert.equal((await post(first, { "X-Vorton-Session": "expired" })).status, 403);
  assert.equal((await post({ ...first, generation: randomUUID() })).status, 409);
  assert.equal((await post({ ...first, workspace: "AubOS" })).status, 400);
  assert.equal((await post({ ...first, protocol: "future" })).status, 400);
  assert.equal((await fetch(`${base}/api/aubos/changes`)).status, 404);
  assert.equal((await fetch(`${base}/api/lastresort/changes?after=invalid`)).status, 400);
  const inputs = [first, ...Array.from({ length: 19 }, (_, index) => request(operation(index + 2)))];
  const receipts = [];
  for (const input of inputs) {
    const response = await post(input); assert.equal(response.status, 200);
    const receipt = await response.json(); assert.equal(receipt.status, "accepted"); receipts.push(receipt);
  }
  for (let index = 0; index < inputs.length; index++) assert.deepEqual(await (await post(inputs[index])).json(), receipts[index]);
  assert.equal((await post({ ...first, operation: { ...first.operation, value: { title: "Different contents" } } })).status, 409);
  const feed = await (await fetch(`${base}/api/lastresort/changes`)).json();
  assert.equal(feed.generation, initial.generation);
  assert.equal(feed.changes.length, 20);
  assert.equal(feed.cursor, feed.head);
  assert.equal(feed.more, false);
  assert.deepEqual(feed.changes.map(item => item.id), inputs.map(input => input.operation.id));
  const later = await (await fetch(`${base}/api/lastresort/changes?after=${receipts[9].cursor}`)).json();
  assert.equal(later.changes.length, 10);
  const metadata = await (await fetch(`${base}/api/lastresort/state?view=replica`)).json();
  assert.equal(metadata.syncCursor, feed.head); assert.equal(metadata.syncGeneration, feed.generation);
  assert.deepEqual(metadata.tasks, []); assert.deepEqual(metadata.goals, []); assert.deepEqual(metadata.ideas, []);
  assert.equal("requests" in metadata, false); assert.equal("auxiliary" in metadata, false);
  const pinnedUrl = `${base}/api/lastresort/changes?after=${receipts[4].cursor}&head=${receipts[9].cursor}&generation=${initial.generation}`;
  const pinned = await (await fetch(pinnedUrl)).json();
  assert.equal(pinned.changes.length, 5); assert.equal(pinned.head, receipts[9].cursor); assert.equal(pinned.more, false);
  assert.equal((await fetch(pinnedUrl.replace(initial.generation, randomUUID()))).status, 409);
  assert.equal((await fetch(`${base}/api/lastresort/changes?head=${receipts[9].cursor}`)).status, 400);
  const state = await (await fetch(`${base}/api/lastresort/state`)).json();
  assert.equal(state.tasks.length, 20);
  assert.equal(state.events.length, 20);
});
test("portable assets reject symlink escapes and only fingerprinted assets receive immutable caching",async t=>{
  const {root,base}=await fixture(t);
  const dist=path.join(root,"dist");
  await mkdir(path.join(dist,"demo-assets"),{recursive:true});
  await writeFile(path.join(dist,"index.html"),"<!doctype html><title>Controlled fixture</title>");
  await writeFile(path.join(dist,"demo-assets/app-12345678.js"),"export const fixture = true;");
  await writeFile(path.join(root,"outside.txt"),"Controlled data outside the served directory");
  await symlink(path.join(root,"outside.txt"),path.join(dist,"demo-assets/escape.js"));
  assert.equal((await fetch(`${base}/demo-assets/escape.js`)).status,404);
  assert.equal((await fetch(`${base}/outside.txt`)).status,404);
  const page=await fetch(`${base}/lastresort/bridge`);
  assert.equal(page.status,200);
  assert.equal(page.headers.get("cache-control"),"no-store");
  const asset=await fetch(`${base}/demo-assets/app-12345678.js`);
  assert.equal(asset.status,200);
  assert.match(asset.headers.get("cache-control"),/immutable/);
  const head=await fetch(`${base}/demo-assets/app-12345678.js`,{method:"HEAD"});
  assert.equal(head.status,200);
  assert.equal(await head.text(),"");
});

test("portable production assets negotiate compression without caching private responses", async t => {
  const {root,base}=await fixture(t);
  const body=Buffer.from("export const fixture = '"+"portable asset ".repeat(1000)+"';");
  await mkdir(path.join(root,"dist/demo-assets"),{recursive:true});
  await writeFile(path.join(root,"dist/demo-assets/app-12345678.js"),body);
  const request=(route,encoding,method="GET")=>new Promise((resolve,reject)=>{
    const req=http.request(base+route,{method,headers:{"Accept-Encoding":encoding}},res=>{
      const chunks=[];res.on("data",chunk=>chunks.push(chunk));
      res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      res.on("error",reject);
    });
    req.on("error",reject);req.end();
  });
  for(const encoding of ["br","gzip"]) {
    const result=await request("/demo-assets/app-12345678.js",encoding);
    assert.equal(result.status,200);
    assert.equal(result.headers["content-encoding"],encoding);
    assert.match(result.headers["cache-control"],/private.*immutable/);
    assert.match(result.headers.vary,/Accept-Encoding/);
    assert.ok(result.body.length<body.length);
    assert.deepEqual(encoding==="br"?brotliDecompressSync(result.body):gunzipSync(result.body),body);
  }
  const plain=await request("/demo-assets/app-12345678.js","br;q=0,gzip;q=0");
  assert.equal(plain.headers["content-encoding"],undefined);
  assert.deepEqual(plain.body,body);
  const head=await request("/demo-assets/app-12345678.js","br","HEAD");
  assert.equal(head.body.length,0);
  assert.equal(Number(head.headers["content-length"]),body.length);
  for(const route of ["/api/lastresort/state","/demo-assets/missing-12345678.js","/api/aubos/state"]) {
    const result=await request(route,"br");
    assert.equal(result.status,route==="/api/lastresort/state"?200:404);
    assert.equal(result.headers["cache-control"],"no-store");
  }
});
