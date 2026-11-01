import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { Store } from "../server/store.mjs";
import { DailyBackups, workspaceBackupSource, attachDailyBackups } from "../server/backup-service.ts";
import { createCoreServer } from "../server/core-http.mjs";
import { restoreBackup } from "../server/backup.ts";
import { IntegrationVault } from "../server/integration-vault.mjs";
import { OmiIntegration } from "../server/omi-integration.mjs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";

test("workspace inventory retains source exports and managed files while keeping integration keys separate", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const state = await store.read("Example");
  await writeFile(path.join(await store.directory("Example"), "core.json"), JSON.stringify(state));
  await store.command("Example", { requestId: randomUUID(), expectedRevision: 0, action: "task.create", payload: { fields: { title: "Keep original export" } } });
  await mkdir(path.join(root, "Example/files"));
  await writeFile(path.join(root, "Example/files/attachment.txt"), "Managed attachment");
  const vault = new IntegrationVault(root, ["Example"]);
  await vault.run("Example", "test", tx => tx.put("state", { retained: true }), { create: true });
  const source = await workspaceBackupSource(root, ["Example"]);
  assert.deepEqual(source.databases, ["Example/state/core.sqlite3", ".runtime/integrations/vault.sqlite"]);
  assert.ok(source.resources.includes("Example/state/core.json"));
  assert.ok(source.resources.includes("Example/files"));
  assert.equal(source.resources.some(value => value.includes("secrets")), false);
  const service = new DailyBackups({ source: async () => source, directory: path.join(root, "backups") });
  service.start();
  const status = await service.run();
  await service.stop();
  assert.equal(status.phase, "ready");
  const restored = path.join(root, "restored");
  await restoreBackup(status.archive, restored);
  assert.equal((await new Store(restored).read("Example")).tasks[0].title, "Keep original export");
  assert.equal(await readFile(path.join(restored, "Example/files/attachment.txt"), "utf8"), "Managed attachment");
  await assert.rejects(new IntegrationVault(restored, ["Example"]).run("Example", "test", tx => tx.get("state")), /original key/);
  assert.deepEqual(await new IntegrationVault(restored, ["Example"], { keyFile: vault.keyFile }).run("Example", "test", tx => tx.get("state")), { retained: true });
  await assert.rejects(workspaceBackupSource(root, ["Missing"]), /required workspace database/);
  const denied = new DailyBackups({ source: async () => ({ ...source, resources: [...source.resources, ".runtime/secrets"] }),
    directory: path.join(root, "forbidden-key-backup") });
  assert.match((await denied.run()).error, /retained separately/);
});

test("startup and hourly checks use one timer and stop without another scheduled run", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-timer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new Store(root).changes("Example");
  let builds = 0, now = new Date("2026-10-30T12:00:00Z");
  const service = new DailyBackups({ directory: path.join(root, "backups"), clock: () => now,
    source: async () => { builds++; return workspaceBackupSource(root, ["Example"]); } });
  service.start(); service.start();
  assert.equal((await service.run()).phase, "ready");
  assert.equal(builds, 1);
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal((await service.run()).phase, "ready");
  assert.equal(builds, 1, "Same-day checks must not repeatedly restore a large verified archive");
  now = new Date("2026-10-31T12:00:00Z");
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal((await service.run()).phase, "ready");
  assert.equal(builds, 2);
  await service.stop();
  t.mock.timers.tick(60 * 60 * 1000);
  assert.equal(builds, 2);
});

test("portable server lifecycle starts and stops its configured daily service", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-http-"));
  const { server, store, backups } = createCoreServer({ root, port: 0, enabledProfiles: ["Example"], defaultPath: "/example/bridge" });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await backups.stop(); await rm(root, { recursive: true, force: true });
  });
  await store.changes("Example");
  attachDailyBackups(server, backups);
  assert.equal(backups.status().phase, "idle");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  assert.equal((await backups.run()).phase, "ready");
  await new Promise(resolve => server.close(resolve));
  await backups.stop();
  assert.equal((await readdir(path.join(root, "backups"))).length, 1);
});

test("daily service coalesces runs, reuses the day after reopen and retains the last success after failure", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await new Store(root).changes("Example");
  let now = new Date("2026-10-30T12:00:00Z"), failure = false, builds = 0;
  const options = { directory: path.join(root, "backups"), clock: () => now, source: async () => {
    builds++;
    if (failure) throw Error("Required resource storage is unavailable");
    return workspaceBackupSource(root, ["Example"]);
  } };
  const service = new DailyBackups(options);
  const one = service.run(), two = service.run();
  assert.equal(one, two);
  const first = await one;
  assert.equal(first.phase, "ready");
  assert.equal(builds, 1);
  assert.equal((await new DailyBackups(options).run()).archive, first.archive);
  assert.deepEqual(await readdir(options.directory), ["daily-2026-10-30.zip"]);
  now = new Date("2026-10-31T12:00:00Z"); failure = true;
  const failed = await service.run();
  assert.equal(failed.phase, "failed");
  assert.equal(failed.archive, first.archive);
  assert.equal(failed.lastSuccessAt, first.lastSuccessAt);
  assert.match(failed.error, /storage is unavailable/);
  failure = false;
  assert.equal((await service.run()).phase, "ready");
  assert.equal((await readdir(options.directory)).length, 2);
  await service.stop();
});

test("HTTP remains responsive during a large SQL snapshot and stop waits for verified publication", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-responsive-"));
  const database = new DatabaseSync(path.join(root, "source.sqlite3"));
  database.exec("CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES(zeroblob(67108864))");
  database.close();
  const source = { root, databases: ["source.sqlite3"], resources: [], recovery: {} };
  const service = new DailyBackups({ source: async () => source, directory: path.join(root, "backups") });
  const server = createServer((_request, response) => response.end("healthy"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let finished = false, requests = 0, maximumLatency = 0;
  const run = service.run();
  const stopped = service.stop().then(() => { finished = true; });
  do {
    const before = performance.now();
    assert.equal(await (await fetch(origin)).text(), "healthy");
    maximumLatency = Math.max(maximumLatency, performance.now() - before); requests++;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (!finished);
  await stopped;
  const result = await run;
  assert.equal(result.phase, "ready");
  assert.ok(requests > 5, "HTTP requests complete throughout capture and verification");
  assert.ok(maximumLatency < 250, `Backup blocked HTTP for ${maximumLatency.toFixed(1)} ms`);
  const restored = path.join(root, "restored");
  await restoreBackup(result.archive, restored);
  const copy = new DatabaseSync(path.join(restored, "source.sqlite3"));
  try { assert.equal(copy.prepare("SELECT length(value) AS bytes FROM payload").get().bytes, 67108864); }
  finally { copy.close(); }
  t.diagnostic(`64 MiB backup: ${requests} concurrent health responses, maximum ${maximumLatency.toFixed(1)} ms; stop waited for verified archive.`);
});

test("a failed capture worker retains the previous archive and can retry after resource recovery", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-backup-worker-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "source.sqlite3"), database = new DatabaseSync(filename);
  database.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('retained')"); database.close();
  let now = new Date("2026-10-30T12:00:00Z");
  const service = new DailyBackups({ directory: path.join(root, "backups"), clock: () => now,
    source: async () => ({ root, databases: ["source.sqlite3"], resources: [], recovery: {} }) });
  const successful = await service.run(), original = await readFile(filename);
  now = new Date("2026-10-31T12:00:00Z"); await writeFile(filename, "not a database");
  const failure = await service.run();
  assert.equal(failure.phase, "failed"); assert.equal(failure.archive, successful.archive);
  assert.equal(failure.lastSuccessAt, successful.lastSuccessAt);
  await writeFile(filename, original);
  assert.equal((await service.run()).phase, "ready"); await service.stop();
  assert.equal((await readdir(path.join(root, "backups"))).length, 2);
});

test("configured integration key files inside a managed tree remain outside its archive", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-configured-key-"));
  const previous = process.env.VORTON_INTEGRATION_KEY_FILE;
  let backups;
  t.after(async () => {
    await backups?.stop();
    if (previous === undefined) delete process.env.VORTON_INTEGRATION_KEY_FILE;
    else process.env.VORTON_INTEGRATION_KEY_FILE = previous;
    await rm(root, { recursive: true, force: true });
  });
  await new Store(root).changes("Example");
  await mkdir(path.join(root, "Example/files"));
  const keyFile = path.join(root, "Example/files/key[local].bin");
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const vault = new IntegrationVault(root, ["Example"], { keyFile });
  await vault.run("Example", "fixture", tx => tx.put("state", { retained: true }), { create: true });
  process.env.VORTON_INTEGRATION_KEY_FILE = keyFile;
  const configured = await workspaceBackupSource(root, ["Example"]);
  assert.deepEqual(configured.protectedResources, ["Example/files/key[local].bin"]);
  delete process.env.VORTON_INTEGRATION_KEY_FILE;
  const host = createCoreServer({ root, port: 0, enabledProfiles: ["Example"], defaultPath: "/example/bridge",
    omi: new OmiIntegration(root, ["Example"], { vault }) });
  backups = host.backups;
  const result = await backups.run();
  assert.equal(result.phase, "ready");
  const target = path.join(root, "restored"), manifest = await restoreBackup(result.archive, target);
  assert.equal(manifest.files.some(file => file.path.endsWith("key[local].bin")), false);
  assert.deepEqual(manifest.recovery.resourceSelection.protectedResources, ["Example/files/key[local].bin"]);
  assert.deepEqual(await new IntegrationVault(target, ["Example"], { keyFile }).run("Example", "fixture", tx => tx.get("state")), { retained: true });
});
