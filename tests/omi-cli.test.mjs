import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const source = new URL("../publication/omi-cli.mjs", import.meta.url);
const script = fileURLToPath(existsSync(source) ? source : new URL("../scripts/omi.mjs", import.meta.url));
const run = args => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

test("portable Omi CLI requires explicit root and workspace and rejects duplicate scope", () => {
  for (const args of [["status"], ["status", "--root", "relative", "--profile", "Example"], ["status", "--root", "/tmp", "--profile", "Example", "--profile", "Other"]]) {
    assert.throws(() => run(args), error => error.status === 1 && String(error.stderr).includes("omi_operation_failed"));
  }
});

test("portable Omi status inspects only the selected empty storage root without creating a vault", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omi-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = run(["status", "--root", root, "--profile", "Example"]);
  assert.equal(status.keyConfigured, false);
  assert.equal(status.historyCount, 0);
  assert.deepEqual(await readdir(root), []);
});

test("the portable template resolves after relocation to scripts without an installation registry", async t => {
  if (!existsSync(source)) return t.skip("The artifact already contains the relocated launcher");
  const artifact = await mkdtemp(path.join(os.tmpdir(), "omi-cli-relocation-"));
  t.after(() => rm(artifact, { recursive: true, force: true }));
  await mkdir(path.join(artifact, "scripts"));
  for (const name of ["server", "shared", "modules"]) await cp(new URL(`../${name}`, import.meta.url), path.join(artifact, name), { recursive: true });
  await rm(path.join(artifact, "server", "private-profiles.mjs"), { force: true });
  await rm(path.join(artifact, "server", "private-profiles.ts"), { force: true });
  const relocated = path.join(artifact, "scripts", "omi.mjs");
  await cp(source, relocated);
  const data = path.join(artifact, "empty-data"); await mkdir(data);
  const result = JSON.parse(execFileSync(process.execPath, [relocated, "status", "--root", data, "--profile", "Example"], { encoding: "utf8" }));
  assert.equal(result.keyConfigured, false); assert.equal(result.historyCount, 0);
  assert.deepEqual(await readdir(data), []);
});

test("installed CLI keeps configured workspace admission and rejects root or credential overrides", async t => {
  if (!existsSync(source)) return t.skip("Installed launcher is intentionally absent from the portable artifact");
  const root = await mkdtemp(path.join(os.tmpdir(), "omi-installed-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const implementation = new URL("../server/omi-cli.ts", import.meta.url).href;
  const program = `import {runInstalledOmiCli} from ${JSON.stringify(implementation)}; await runInstalledOmiCli({root:process.argv[1],profiles:['Example']},process.argv.slice(2));`;
  const installed = args => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", program, root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  for (const args of [["status"], ["status", "--profile", "Unknown"], ["status", "--profile", "Example", "--root", root], ["status", "--profile", "Example", "--key", "SYNTHETIC_CANARY"]]) {
    assert.throws(() => installed(args), error => error.status === 1 && String(error.stderr).includes("omi_operation_failed") && !String(error.stderr).includes("SYNTHETIC_CANARY"));
  }
  assert.equal(installed(["status", "--profile", "Example"]).keyConfigured, false);
  assert.deepEqual(await readdir(root), []);
});
