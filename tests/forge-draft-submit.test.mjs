import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../web/forge-draft-submit.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { checkDraftBaseline, submitExplicitCommand } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const state = (profile = "AubOS", revision = 42) => ({ profile, revision, goals: [], tasks: [], ideas: [], recommendations: [], events: [] });
function fixture(overrides = {}) {
  const calls = [], commits = [];
  const input = {
    installationId: "synthetic-installation", variant: "private", profile: "AubOS", action: "idea.create",
    payload: { fields: { title: "Synthetic draft" } }, token: "live-token-only",
    preconditions: { basedOnRevision: 42 },
    model: () => state(),
    authority: () => ({ installationId: "synthetic-installation", variant: "private", profile: "AubOS", canWrite: true }),
    assertLive: () => {},
    scopeCurrent: async () => true,
    commit: value => commits.push(value),
    fetcher: async (...args) => { calls.push(args); return Response.json(state("AubOS", 43)); },
    ...overrides,
  };
  return { input, calls, commits };
}

test("draft revisions require equality even when digest revisions decrease", () => {
  assert.equal(checkDraftBaseline(42, { basedOnRevision: 42, entityVersion: 2 }, 2), undefined);
  for (const revision of [41, 43]) assert.equal(checkDraftBaseline(revision, { basedOnRevision: 42 }).status, "conflict");
  assert.equal(checkDraftBaseline(42, { basedOnRevision: 42, entityVersion: 2 }, 3).status, "conflict");
  assert.equal(checkDraftBaseline(42, { basedOnRevision: 42, entityVersion: 2 }).status, "conflict");
});

test("equal numeric revisions cannot authorize a draft from another server generation", async () => {
  assert.equal(checkDraftBaseline(42, { basedOnRevision: 42, entityVersion: 2, syncGeneration: "old-history" }, 2, "new-history").status, "conflict");
  const f = fixture({ preconditions: { basedOnRevision: 42, syncGeneration: "old-history" }, model: () => ({ ...state(), syncGeneration: "new-history" }) });
  assert.equal((await submitExplicitCommand(f.input)).status, "conflict"); assert.equal(f.calls.length, 0);
});

test("a legacy draft without history must be reviewed before an online save to a generation-aware server", async () => {
  assert.equal(checkDraftBaseline(42, { basedOnRevision: 42 }, undefined, "current-history").status, "conflict");
  const f = fixture({ model: () => ({ ...state(), syncGeneration: "current-history" }) });
  assert.equal((await submitExplicitCommand(f.input)).status, "conflict");
  assert.equal(f.calls.length, 0);
});

test("a generation change while preparing an attempt prevents POST even if its numeric revision is unchanged", async () => {
  let generation = "old-history";
  const f = fixture({ model: () => ({ ...state(), syncGeneration: generation }), prepareAttempt: async () => { generation = "new-history"; return true; } });
  assert.equal((await submitExplicitCommand(f.input)).status, "conflict"); assert.equal(f.calls.length, 0);
});
test("foreground commands carry the reviewed server generation to transactional validation", async () => {
  const generation = "reviewed-history";
  const f = fixture({ model: () => ({ ...state(), syncGeneration: generation }),
    preconditions: { basedOnRevision: 42, syncGeneration: generation },
    fetcher: async (...args) => { f.calls.push(args); return Response.json({ ...state("AubOS", 43), syncGeneration: generation }); } });
  assert.equal((await submitExplicitCommand(f.input)).status, "saved");
  assert.equal(JSON.parse(f.calls[0][1].body).expectedGeneration, generation);
});

test("missing live authority, foreign installation/profile and obsolete scope prevent POST", async () => {
  for (const overrides of [
    { token: "" },
    { authority: () => ({ installationId: "synthetic-installation", variant: "private", profile: "AubOS", canWrite: false }) },
    { authority: () => ({ installationId: "other", variant: "private", profile: "AubOS", canWrite: true }) },
    { authority: () => ({ installationId: "synthetic-installation", variant: "private", profile: "LastResort", canWrite: true }) },
    { authority: () => ({ installationId: "synthetic-installation", variant: "portable", profile: "AubOS", canWrite: true }) },
    { scopeCurrent: async () => false },
    { scopeCurrent: async () => { throw Error("Storage unavailable"); } },
    { model: () => state("LastResort") },
  ]) {
    const f = fixture(overrides);
    assert.equal((await submitExplicitCommand(f.input)).status, "blocked");
    assert.equal(f.calls.length, 0); assert.equal(f.commits.length, 0);
  }
});

test("draft conflict is checked against the model after asynchronous authority verification", async () => {
  let model = state();
  const f = fixture({ model: () => model, scopeCurrent: async () => { model = state("AubOS", 1); return true; } });
  assert.equal((await submitExplicitCommand(f.input)).status, "conflict");
  assert.equal(f.calls.length, 0);
});

test("one explicit save uses the exact profile and current revision then commits a validated model", async () => {
  const f = fixture();
  assert.deepEqual(await submitExplicitCommand(f.input), { status: "saved" });
  assert.equal(f.calls.length, 1); assert.equal(f.commits.length, 1);
  const [url, init] = f.calls[0]; const command = JSON.parse(init.body);
  assert.equal(url, "/api/aubos/command");
  assert.equal(command.expectedRevision, 42);
  assert.equal(command.action, "idea.create");
  assert.match(command.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(init.headers["X-Vorton-Session"], "live-token-only");
  assert.equal(init.credentials, "same-origin");
});

test("contract 403 and validation 4xx are blocked; 409 is conflict", async () => {
  for (const code of [400, 403, 409, 413, 415, 422]) {
    const f = fixture({ fetcher: async () => Response.json({ error: "Synthetic rejection" }, { status: code }) });
    const result = await submitExplicitCommand(f.input);
    assert.equal(result.status, code === 409 ? "conflict" : "blocked");
    assert.equal(result.message, "Synthetic rejection"); assert.equal(f.commits.length, 0);
  }
});

test("lost responses, proxy errors and invalid successful confirmations retain an unknown request hint", async () => {
  for (const fetcher of [
    async () => { throw Error("Connection lost after possible commit"); },
    async () => new Response("Proxy HTML", { status: 502 }),
    async () => Response.json({ error: "Writer timed out" }, { status: 503 }),
    async () => Response.json({}, { status: 409 }),
    async () => Response.json(state("LastResort")),
    async () => Response.json({ ...state(), tasks: null }),
    async () => Response.json({ ...state(), canonical: { projection: "unknown" } }),
  ]) {
    const f = fixture({ fetcher }); const result = await submitExplicitCommand(f.input);
    assert.equal(result.status, "unknown"); assert.match(result.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(result.message, "We couldn’t confirm the save. Check current records before trying again.");
    assert.equal(f.commits.length, 0);
    const retry = fixture({ unknownRequestId: result.requestId });
    assert.equal((await submitExplicitCommand(retry.input)).requestId, result.requestId);
    assert.equal(retry.calls.length, 0);
  }
});

test("scope changes during submission prevent cache publication without claiming the save failed", async () => {
  let current = true;
  const f = fixture({ scopeCurrent: async () => current, fetcher: async () => { current = false; return Response.json(state()); } });
  assert.equal((await submitExplicitCommand(f.input)).status, "saved");
  assert.equal(f.commits.length, 0);
});

test("validated canonical acknowledgement stays saved when local authority or publication fails", async () => {
  const cacheFailure = fixture({ commit: async () => { throw Error("Local cache unavailable after canonical save"); } });
  let confirmed = false;
  const admissionChanged = fixture({ assertLive: () => { if (confirmed) throw Error("Admission changed"); } });
  admissionChanged.input.fetcher = async (...args) => {
    admissionChanged.calls.push(args); confirmed = true; return Response.json(state());
  };
  for (const f of [cacheFailure, admissionChanged]) {
    assert.deepEqual(await submitExplicitCommand(f.input), { status: "saved" });
    assert.equal(f.calls.length, 1);
  }
  assert.equal(admissionChanged.commits.length, 0);
});

test("canonical confirmation waits for asynchronous cache publication and remains saved after a local CAS loss", async () => {
  let release, complete = false;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ commit: async () => { await pending; complete = true; } });
  const result = submitExplicitCommand(f.input);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(complete, false);
  release();
  assert.deepEqual(await result, { status: "saved" });
  assert.equal(complete, true);
  assert.equal(f.calls.length, 1);
});

test("attempt marker is prepared with the exact request ID before dispatch; failed preparation sends no POST", async () => {
  let prepared;
  const f = fixture({ prepareAttempt: async requestId => { prepared = requestId; return true; } });
  assert.deepEqual(await submitExplicitCommand(f.input), { status: "saved" });
  assert.equal(JSON.parse(f.calls[0][1].body).requestId, prepared);
  for (const prepareAttempt of [async () => false, async () => { throw Error("Cannot persist hint"); }]) {
    const blocked = fixture({ prepareAttempt });
    assert.equal((await submitExplicitCommand(blocked.input)).status, "blocked");
    assert.equal(blocked.calls.length, 0);
  }
});
