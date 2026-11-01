import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, mkdir, copyFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "../server/store.mjs";
import * as typedStore from "../server/store.ts";
import * as council from "../server/council.mjs";
import * as typedCouncil from "../server/council.ts";
import * as review from "../server/review.mjs";
import * as typedReview from "../server/review.ts";
import * as http from "../server/core-http.mjs";
import * as typedHttp from "../server/core-http.ts";
import * as view from "../server/council-state-view.mjs";
import * as typedView from "../server/council-state-view.ts";
import * as seed from "../scripts/demo-seed.mjs";
import * as typedSeed from "../scripts/demo-seed.ts";

test("compatibility modules expose the same runtime exports as TypeScript", () => {
  for (const [bridge, runtime] of [[store, typedStore], [council, typedCouncil], [review, typedReview], [http, typedHttp], [view, typedView], [seed, typedSeed]]) {
    assert.deepEqual(Object.keys(bridge), Object.keys(runtime));
    for (const key of Object.keys(runtime)) assert.equal(bridge[key], runtime[key]);
  }
});

for (const extension of ["mjs", "ts"]) {
  test(`portable ${extension} seed command populates only its own root and refuses a second seed`, async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vorton-seed-entry-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "scripts"));
    for (const suffix of ["mjs", "ts"]) await copyFile(new URL(`../scripts/demo-seed.${suffix}`, import.meta.url), path.join(root, "scripts", `demo-seed.${suffix}`));
    for (const directory of ["server", "modules", "demo"]) await symlink(fileURLToPath(new URL(`../${directory}`, import.meta.url)), path.join(root, directory), "dir");
    const invoke = () => spawnSync(process.execPath, [path.join(root, "scripts", `demo-seed.${extension}`)], { encoding: "utf8" });
    const first = invoke();
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /Loaded fictional Last Resort fixtures at revision 2/);
    const local = new store.Store(path.join(root, ".runtime", "last-resort"));
    const before = await local.read("LastResort");
    assert.equal(before.goals.length, 3);
    assert.equal(before.tasks.length, 5);
    assert.equal(before.councilSessions.length, 1);
    const second = invoke();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already contains work/);
    assert.deepEqual(await local.read("LastResort"), before);
  });

  test(`portable ${extension} launcher retains reserved-port admission`, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/demo.${extension}`, import.meta.url))], {
      encoding: "utf8", env: { ...process.env, VORTON_DEMO_PORT: "47833" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid or reserved demo port/);
  });
}

test("both transition entrypoints preserve an owner rejection without creating planning records", () => {
  const state = { profile: "LastResort", revision: 0, goals: [], tasks: [], ideas: [], recommendations: [
    { id: "proposal", kind: "task", status: "pending", proposal: { title: "Advisory only" } },
  ] };
  for (const extension of ["mjs", "ts"]) {
    const result = spawnSync(process.execPath, [new URL(`../server/council-transition.${extension}`, import.meta.url).pathname, "/nonexistent-runtime-fixture"], {
      input: JSON.stringify({ state, command: { action: "recommendation.resolve", payload: { id: "proposal", decision: "rejected", note: "Do not execute" } } }), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.recommendations[0].status, "rejected");
    assert.equal(output.recommendations[0].ownerNote, "Do not execute");
    assert.equal(output.planning, null);
    assert.deepEqual(output.ideas, []);
  }
});
