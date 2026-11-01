import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const installationId = "7737bfda-9875-45d7-8d03-572908f8788f";
const entity = { owner: "Owner", priority: "normal", projects: ["Existing, exact"], tags: [], ideaIds: ["idea-existing"], version: 1, history: [] };
const idea = { ...entity, id: "idea-existing", title: "Existing idea", status: "inbox", description: "Original description", original: "Original description",
  goalIds: ["goal-existing"], value: "unknown", complexity: "unknown", effort: "unknown", upkeep: "unknown", confidence: "unknown", pull: "unknown",
  startCondition: "", experiment: "", reviewOn: "", evidence: "" };
const model = profile => ({ profile, revision: 42, goals: [{ ...entity, id: "goal-existing", title: "Existing goal", status: "active", intent: "Initial intent", successCriteria: "Initial criteria", horizon: "", parentId: "", reviewOn: "", evidence: "", progress: 0, milestones: [] }],
  tasks: [{ ...entity, id: "task-existing", title: "Existing task", status: "todo", notes: "Initial notes", goalId: "goal-existing", dueOn: "" }],
  ideas: [idea], recommendations: [], events: [], councilSessions: [] });

async function waitForDraft(page, kind, targetId, fields) {
  // Playwright's predicate polling treats a returned Promise as truthy. Await
  // each IDB read inside this loop so a false result really retries.
  return page.evaluate(async ({kind,targetId,fields}) => {
    const deadline = performance.now() + 15000;
    do {
      const saved = await window.fixtureReadDraft(kind,targetId);
      if (saved.ok && saved.value && Object.entries(fields).every(([key,value]) => saved.value.fields[key] === value)) return saved.value;
      await new Promise(requestAnimationFrame);
    } while (performance.now() < deadline);
    throw new Error(`Persisted draft did not match ${kind}/${targetId}: ${JSON.stringify(fields)}`);
  }, {kind,targetId,fields});
}

test("ordinary drafts survive route/process loss, isolate profiles, and require explicit conflict/unknown review", {
  skip: !process.env.OFFLINE_BROWSER, timeout: 120000,
}, async t => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(path.resolve(".runtime/forge-drafts-browser-"));
  const models = { LastResort: model("LastResort"), FreedOS: model("FreedOS") };
  const posts = []; let outcome = "saved", failReads = false, sessionReads = 0, releaseResponse, browser, server;
  let readHolds = 0;
  const heldReads = [];
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WorkspaceApp} from '/web/workspace.tsx';
    import {workspaceAccess} from '/web/application/offline-access.ts';
    import {captureOfflineScope,saveVerifiedAdmission,clearSavedData,readDraft,saveDraft,captureReadTicket,saveVerifiedModel} from '/web/application/offline-store.ts';
    import {profileCache} from '/web/application/profile-cache.ts';
    import '/web/design/fonts.css'; import '/web/design/themes.css';
    const admission={schema:1,installationId:${JSON.stringify(installationId)},variant:'portable',profiles:['LastResort','FreedOS'],verifiedAt:Date.now()};
    const params=new URLSearchParams(location.search); const legacy=params.has('legacy'),memory=legacy||params.has('memory');
    if(memory)Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Unavailable','SecurityError');}});
    const result=memory?undefined:await captureOfflineScope(admission); const scope=result?.value;
    if(scope)await saveVerifiedAdmission(scope,admission);
    if(!legacy){workspaceAccess.manage('portable');if(scope)workspaceAccess.restore(admission,scope);else workspaceAccess.admitOnline(admission);}
    const models=await fetch('/fixture-models').then(r=>r.json());
    for(const [profile,state] of Object.entries(models))profileCache.write(profile,state);
    const root=createRoot(document.getElementById('root')); let profile='LastResort';
    window.fixtureShow=(nextProfile,page='forge',view='ideas')=>{
      profile=nextProfile;workspaceAccess.setProfile(profile);
      history.replaceState(null,'','/'+profile.toLowerCase()+'/'+page+(page==='forge'?'/'+view:''));
      root.render(<div className="dashboard-shell"><WorkspaceApp profile={profile} page={page} forgeView={view}/></div>);
    };
    window.fixtureOnline=()=>{if(legacy)return;workspaceAccess.admitOnline({...admission,verifiedAt:Date.now()},scope);workspaceAccess.setProfile(profile);workspaceAccess.confirmLive(workspaceAccess.getSnapshot());};
    window.fixtureOffline=()=>workspaceAccess.fail('Offline fixture');
    // Deliberately omit the authority notification to model another tab's
    // committed clear arriving before its BroadcastChannel message.
    window.fixtureClearReads=()=>clearSavedData(scope,'reads');
    window.fixtureReadCapture=()=>readDraft(scope,{profile,schema:1,kind:'forge-capture-v1',targetId:'new'});
    window.fixtureReadDraft=(kind,targetId)=>readDraft(scope,{profile,schema:1,kind,targetId});
    window.fixtureReplaceCapture=async()=>{
      const current=await window.fixtureReadCapture();
      return saveDraft(scope,{key:current.value.key,fields:{title:'Other tab cleanup winner'},baseline:current.value.baseline},{expectedSavedAt:current.value.savedAt});
    };
    window.fixtureRead=()=>profileCache.load(profile,true).catch(()=>{});
    window.fixturePersist=async(value)=>{
      const key={installationId:scope.installationId,variant:scope.variant,profile,schema:1,kind:'workspace',id:'current'};
      const ticket=await captureReadTicket(scope,key);
      if(!ticket.ok)return ticket;
      return saveVerifiedModel(scope,{key,verifiedAt:Date.now(),value},ticket.value);
    };
    window.fixtureRevisions=[];
    profileCache.subscribe('LastResort',()=>window.fixtureRevisions.push(profileCache.read('LastResort').state?.revision));
    window.fixtureHoldDraftWrites=()=>new Promise(resolve=>{
      const opening=indexedDB.open('vorton-offline-v1');opening.onsuccess=()=>{
        const db=opening.result,tx=db.transaction('drafts','readwrite');let released=false;
        window.fixtureReleaseDraftWrites=()=>{released=true;};tx.oncomplete=()=>db.close();
        const next=()=>{if(released)return;tx.objectStore('drafts').get('fixture-lock').onsuccess=next;};next();resolve();
      };
    });
    window.fixtureTrackDraftWrites=()=>{
      window.fixtureDraftWrites=0;const original=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(names,mode,...options){
        if(mode==='readwrite'&&[].concat(names).includes('drafts'))window.fixtureDraftWrites++;
        return original.call(this,names,mode,...options);
      };
    };
    window.fixtureShow('LastResort'); window.fixtureReady=true;
    if(memory&&!legacy)workspaceAccess.confirmLive(workspaceAccess.getSnapshot());
  `;
  try {
    server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(root, "vite-cache"), logLevel: "error",
      server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
      plugins: [{ name: "synthetic-draft-fixture",
        resolveId: id => id === "/web/forge-drafts-fixture.tsx" ? path.resolve("web/forge-drafts-fixture.tsx") : undefined,
        load: id => id.endsWith("/web/forge-drafts-fixture.tsx") ? entry : undefined,
        configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
          if (req.url === "/fixture-models") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(models)); return; }
          if (!req.url?.startsWith("/lastresort/forge/ideas")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<html data-theme="starship-light"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/web/forge-drafts-fixture.tsx"></script></body></html>'));
        }); },
      }] });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    async function open(width = 1280) {
      browser = await chromium.launchPersistentContext(path.join(root, "browser"), { executablePath: process.env.OFFLINE_BROWSER, headless: true, viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await browser.route("**/api/**", async route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.pathname === "/api/session") { sessionReads++; return route.fulfill({ json: { installationId, variant: "portable", token: "online-only-token", profiles: Object.keys(models) } }); }
        const profile = url.pathname.includes("/freedos/") ? "FreedOS" : "LastResort";
        if (request.method() !== "POST") {
          if (failReads) return route.fulfill({ status: 503, json: { error: "Synthetic read unavailable" } });
          const responseModel = structuredClone(models[profile]);
          if (readHolds > 0) {
            readHolds--;
            await new Promise(resolve => heldReads.push({ release: resolve, state: responseModel }));
          }
          return route.fulfill({ json: responseModel });
        }
        const command = request.postDataJSON(); posts.push(command);
        if (command.expectedRevision !== models[profile].revision) return route.fulfill({ status: 409, json: { error: "Records changed" } });
        if (outcome === "conflict") return route.fulfill({ status: 409, json: { error: "Synthetic conflict" } });
        if (outcome === "blocked") return route.fulfill({ status: 403, json: { error: "Session expired" } });
        const kind = command.action.split(".")[0], records = models[profile][kind === "idea" ? "ideas" : kind === "goal" ? "goals" : "tasks"];
        const prior = records.find(record => record.id === command.payload.id);
        if (prior) Object.assign(prior, command.payload.fields, { version: prior.version + 1 });
        else records.push({ ...(kind === "idea" ? idea : entity), ...command.payload.fields, id: "created-" + command.requestId });
        models[profile].revision++;
        const responseModel = structuredClone(models[profile]);
        if (outcome === "unknown") return route.abort("failed");
        if (outcome === "delayed") await new Promise(resolve => { releaseResponse = resolve; });
        return route.fulfill({ json: responseModel }).catch(() => {});
      });
      const page = await browser.newPage(); page.setDefaultTimeout(15000);
      await page.goto(origin + "/lastresort/forge/ideas");
      await page.waitForFunction(() => window.fixtureReady);
      await page.locator("#forge-capture").waitFor();
      return page;
    }
    let page = await open();
    await page.locator(".forge-filters select").first().selectOption("Existing, exact");
    await page.locator("#forge-capture").fill("Capture survives process loss");
    await waitForDraft(page,"forge-capture-v1","new",{title:"Capture survives process loss"});
    assert.equal(await page.locator(".forge-capture button[type=submit], .forge-capture button:not([type])").first().isDisabled(), true);
    await page.locator("#forge-capture").press("Enter"); assert.equal(posts.length, 0);
    await page.evaluate(() => window.fixtureShow("LastResort", "tools"));
    await page.evaluate(() => window.fixtureShow("LastResort"));
    await page.locator("#forge-capture").waitFor(); assert.equal(await page.locator("#forge-capture").inputValue(), "Capture survives process loss");
    await browser.close(); browser = undefined;
    page = await open(390);
    assert.equal(await page.locator("#forge-capture").inputValue(), "Capture survives process loss");
    await page.evaluate(() => window.fixtureShow("FreedOS"));
    await page.locator("#forge-capture").waitFor(); assert.equal(await page.locator("#forge-capture").inputValue(), "");
    await page.evaluate(() => window.fixtureShow("LastResort"));
    await page.locator("#forge-capture").waitFor(); assert.equal(await page.locator("#forge-capture").inputValue(), "Capture survives process loss");

    for (const kind of ["goal", "task"]) {
      await page.evaluate(kind => window.fixtureShow("LastResort", "forge", kind + "s"), kind);
      await page.getByRole("button", { name: "New " + kind, exact: true }).click();
      const dialog = page.getByRole("dialog"); await dialog.locator('input[name="title"]').fill("Offline " + kind);
      const raw = kind === "goal" ? "[ ] First milestone\n[x] Second milestone" : "Completion evidence\nwith a second line";
      await dialog.locator(`textarea[name="${kind === "goal" ? "milestones" : "notes"}"]`).fill(raw);
      await dialog.locator('input[name="projects"]').fill("  Raw label ,Second");
      await waitForDraft(page,`${kind}-editor-v1`,"new",{title:`Offline ${kind}`,projects:"  Raw label ,Second",[kind === "goal" ? "milestones" : "notes"]:raw});
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "New " + kind, exact: true }).click();
      assert.equal(await dialog.locator('input[name="title"]').inputValue(), "Offline " + kind);
      assert.equal(await dialog.locator('input[name="projects"]').inputValue(), "  Raw label ,Second");
      assert.equal(await dialog.locator(`textarea[name="${kind === "goal" ? "milestones" : "notes"}"]`).inputValue(), raw);
      assert.equal(await dialog.getByRole("button", { name: "Save " + kind, exact: true }).isDisabled(), true);
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => window.fixtureShow("LastResort"));
    await page.getByRole("button", { name: "Existing idea", exact: true }).click();
    await page.getByRole("button", { name: "Edit idea", exact: true }).click();
    const ideaDialog = page.getByRole("dialog");
    await ideaDialog.locator('textarea[name="description"]').fill("Offline description\nPreserve original meaning");
    await waitForDraft(page,"idea-editor-v1","idea-existing",{description:"Offline description\nPreserve original meaning"});
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Edit idea", exact: true }).click();
    assert.equal(await ideaDialog.locator('textarea[name="description"]').inputValue(), "Offline description\nPreserve original meaning");
    await page.keyboard.press("Escape");

    // Reconnection enables authority but sends nothing until explicit submit.
    assert.equal(sessionReads, 0, "managed saved reads never load an independent live session");
    await page.evaluate(() => window.fixtureOnline()); assert.equal(posts.length, 0);
    failReads = true;
    await page.evaluate(() => window.fixtureRead());
    await page.getByRole("alert").getByText("Request failed (503)", { exact: true }).waitFor();
    failReads = false;
    await page.evaluate(() => window.fixtureRead());
    await page.getByRole("alert").waitFor({ state: "hidden" });
    assert.equal(sessionReads, 0, "live managed record reads still rely on shared admission");
    models.LastResort.revision++;
    await page.locator("#forge-capture").press("Enter");
    await page.locator(".forge-capture").getByText("Records changed", { exact: true }).waitFor();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].payload.fields.projects, ["Existing, exact"]);
    await page.locator(".forge-capture").getByRole("button", { name: "Review current records" }).click();
    await page.getByRole("alert").getByText("Records changed", { exact: true }).waitFor();
    await page.locator(".forge-capture").getByRole("button", { name: "Use reviewed revision for this draft" }).click();
    outcome = "unknown";
    await page.locator("#forge-capture").press("Enter");
    await page.locator(".forge-capture").getByText("We couldn’t confirm the save. Check current records before trying again.", { exact: true }).waitFor();
    await waitForDraft(page,"forge-capture-v1","new",{title:"Capture survives process loss",__vortonUnknownRequest:posts.at(-1).requestId});
    const count = posts.length;
    await page.locator("#forge-capture").press("Enter"); assert.equal(posts.length, count);
    await page.reload(); await page.locator("#forge-capture").waitFor();
    await page.locator(".forge-capture").getByText(/We couldn.t confirm the save\. Check current records before trying again/).waitFor();
    assert.equal(posts.length, count);
    await page.evaluate(() => window.fixtureOnline());
    await page.locator(".forge-capture").getByRole("button", { name: "Review current records" }).click();
    await page.locator(".forge-capture details summary").click();
    assert.match(await page.locator(".forge-capture pre").innerText(), /Capture survives process loss/);
    await page.locator(".forge-capture").getByRole("button", { name: "Discard local draft", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#forge-capture').value === "");
    assert.equal(posts.length, count);
    // An older successful response must not remove text typed during its POST.
    await page.locator("#forge-capture").fill("Submitted version");
    outcome = "delayed";
    await page.locator("#forge-capture").press("Enter");
    await page.waitForFunction(() => document.querySelector('.forge-capture button').disabled);
    for (let attempts = 0; !releaseResponse && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseResponse, "the delayed canonical request must have started");
    await page.locator("#forge-capture").fill("Newer typing survives earlier save");
    await waitForDraft(page,"forge-capture-v1","new",{title:"Newer typing survives earlier save"});
    releaseResponse(); releaseResponse = undefined;
    await page.locator(".forge-capture").getByText("The submitted version was saved. Newer edits remain a local draft.", { exact: true }).waitFor();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "Newer typing survives earlier save");
    await page.evaluate(() => window.fixtureOnline());
    await page.locator(".forge-capture").getByRole("button", { name: "Review current records" }).click();
    await page.locator(".forge-capture").getByRole("button", { name: "Use reviewed revision for this draft" }).click();
    outcome = "saved";
    await page.locator("#forge-capture").press("Enter");
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
    await page.reload();
    await page.locator("#forge-capture").waitFor();
    assert.equal(await page.locator("#forge-capture").inputValue(), "");
    assert.equal(posts.length, count + 2);
    // Existing goal/task forms retain their implicit idea relationships.
    for (const kind of ["goal", "task"]) {
      await page.evaluate(kind => window.fixtureShow("LastResort", "forge", kind + "s"), kind);
      await page.evaluate(() => window.fixtureOnline());
      const edit = kind === "task" ? page.locator("#task-task-existing").getByRole("button", {name:models.LastResort.tasks[0].title,exact:true}) : page.getByRole("button", { name: "Edit goal", exact: true }).first();
      await edit.click();
      const dialog = page.getByRole("dialog");
      await dialog.locator('input[name="title"]').waitFor();
      assert.equal(await dialog.locator('input[name="title"]').evaluate(node => node === document.activeElement), true);
      assert.equal(await dialog.evaluate(node => node.getBoundingClientRect().width <= innerWidth), true);
      await page.evaluate(() => window.fixtureOffline());
      await dialog.locator('input[name="title"]').fill("Offline edited " + kind);
      await waitForDraft(page,`${kind}-editor-v1`,`${kind}-existing`,{title:`Offline edited ${kind}`});
      assert.equal(await dialog.getByRole("button", { name: "Save " + kind, exact: true }).isDisabled(), true);
      await page.keyboard.press("Escape");
      await edit.click();
      assert.equal(await dialog.locator('input[name="title"]').inputValue(), "Offline edited " + kind);
      const addedId = "idea-added-" + kind;
      models.LastResort.ideas.push({ ...idea, id: addedId, title: "Added relationship " + kind });
      const changed = models.LastResort[kind === "goal" ? "goals" : "tasks"][0];
      changed.ideaIds = [...changed.ideaIds, addedId]; changed.version++; models.LastResort.revision++;
      await page.evaluate(() => window.fixtureOnline());
      await dialog.getByRole("button", { name: "Save " + kind, exact: true }).click();
      await dialog.getByRole("button", { name: "Review current records", exact: true }).click();
      await dialog.getByRole("button", { name: "Use reviewed revision for this draft", exact: true }).click();
      await dialog.getByRole("button", { name: "Save " + kind, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(posts.at(-1).action, kind + ".update");
      assert.deepEqual(posts.at(-1).payload.fields.ideaIds, ["idea-existing", addedId]);
    }
    // Direct status changes preserve the full task payload and use the same
    // guarded foreground writer as the ordinary editor, never an offline queue.
    await page.evaluate(() => window.fixtureShow("LastResort", "forge", "tasks"));
    await page.getByRole("group", { name: "Task views" }).getByRole("button", { name: "Board", exact: true }).click();
    const taskRow = page.locator("#task-task-existing");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.fixtureOnline());
      const { id, version, createdAt, updatedAt, history, ...fields } = structuredClone(models.LastResort.tasks[0]);
      const revision = models.LastResort.revision;
      await page.evaluate(() => window.fixtureOffline());
      const complete = taskRow.getByRole("checkbox", { name: /^Complete task:/ });
      assert.equal(await complete.isDisabled(), true);
      const beforeOffline = posts.length;
      await complete.evaluate(button => button.click());
      assert.equal(posts.length, beforeOffline);
      await page.evaluate(() => window.fixtureOnline());
      outcome = "delayed";
      await complete.click();
      for (let attempts = 0; !releaseResponse && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(releaseResponse);
      assert.equal(await complete.isDisabled(), true, "busy status changes cannot send another command");
      assert.deepEqual(posts.at(-1).payload, { id, fields: { ...fields, status: "done" } });
      assert.equal(posts.at(-1).expectedRevision, revision);
      assert.equal(models.LastResort.tasks[0].version, version + 1);
      releaseResponse(); releaseResponse = undefined;
      await page.getByText("Task completed.", { exact: true }).waitFor();
      // Completed tasks leave the Active board in the reviewed interface.
      await page.locator("#ftb-status-done").click();
      const reopen = taskRow.getByRole("checkbox", { name: /^Reopen task:/ });
      await reopen.waitFor(); outcome = "saved";
      await reopen.focus(); await page.keyboard.press("Enter");
      await page.getByText("Task reopened.", { exact: true }).waitFor();
      await page.locator("#ftb-status-active").click();
      assert.deepEqual(posts.at(-1).payload.fields, { ...fields, status: "todo" });
      assert.equal(models.LastResort.tasks[0].version, version + 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    outcome = "conflict";
    await taskRow.getByRole("checkbox", { name: /^Complete task:/ }).click();
    await page.getByRole("alert").getByText("Synthetic conflict", { exact: true }).waitFor();
    assert.equal(await page.getByText("Synthetic conflict", { exact: true }).count(), 1, "action failures appear once");
    const rejectedCount = posts.length;
    await page.getByRole("button", { name: "Refresh records", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "hidden" });
    assert.equal(posts.length, rejectedCount, "refresh acknowledges the error without retrying the action");
    await taskRow.getByRole("checkbox", { name: /^Complete task:/ }).click();
    await page.getByRole("alert").getByText("Synthetic conflict", { exact: true }).waitFor();
    await page.evaluate(() => window.fixtureShow("LastResort", "forge", "ideas"));
    await page.getByRole("alert").waitFor({ state: "hidden" });
    assert.equal(posts.length, rejectedCount + 1, "navigation does not replay failed commands");
    await page.evaluate(() => window.fixtureShow("LastResort", "forge", "tasks"));
    outcome = "unknown";
    await taskRow.getByRole("checkbox", { name: /^Complete task:/ }).click();
    await page.getByText(/A save may already have reached the server/).waitFor();
    const unknownToggleCount = posts.length;
    const blockedToggle = taskRow.getByRole("checkbox", { name: /^Complete task:/ });
    assert.equal(await blockedToggle.isDisabled(), true);
    await blockedToggle.evaluate(button => button.click());
    assert.equal(posts.length, unknownToggleCount);
    failReads = true;
    await page.getByRole("button", { name: "Review current task records", exact: true }).click();
    await page.getByRole("status").getByText("Request failed (503)", { exact: true }).waitFor();
    assert.equal(await blockedToggle.isDisabled(), true, "a failed review does not enable another toggle");
    failReads = false; outcome = "saved";
    await page.getByRole("button", { name: "Review current task records", exact: true }).click();
    await page.getByText("Current task records loaded. Review their status before another action.", { exact: true }).waitFor();
    assert.equal(posts.length, unknownToggleCount, "review reads current evidence without replaying the unknown command");
    await page.locator("#ftb-status-done").click();
    await taskRow.getByRole("checkbox", { name: /^Reopen task:/ }).click();
    await page.getByText("Task reopened.", { exact: true }).waitFor();
    await page.locator("#ftb-status-active").click();
    assert.equal(posts.length, unknownToggleCount + 1);
    // A managed force-load joins pending reads. Hold a pre-POST snapshot,
    // lose the committed POST response, and hold the independent review GET.
    readHolds = 2;
    await page.evaluate(() => { void window.fixtureRead(); });
    for (let attempts = 0; heldReads.length < 1 && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(heldReads.length, 1);
    const oldRevision = heldReads[0].state.revision;
    assert.equal(heldReads[0].state.tasks[0].status, "todo");
    outcome = "unknown";
    await taskRow.getByRole("checkbox", { name: /^Complete task:/ }).click();
    await page.getByText(/A save may already have reached the server/).waitFor();
    const pendingReviewPosts = posts.length;
    const reviewAction = page.getByRole("button", { name: "Review current task records", exact: true });
    await reviewAction.click();
    assert.equal(await reviewAction.isDisabled(), true);
    assert.equal(heldReads.length, 1, "review first waits out the pre-POST read");
    heldReads[0].release();
    for (let attempts = 0; heldReads.length < 2 && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(heldReads.length, 2, "review starts an independent fresh GET after the old read settles");
    assert.equal(heldReads[1].state.revision, oldRevision + 1);
    assert.equal(heldReads[1].state.tasks[0].status, "done");
    assert.equal(await taskRow.getByRole("checkbox", { name: /^Complete task:/ }).isDisabled(), true);
    assert.equal(await page.getByText("Current task records loaded. Review their status before another action.", { exact: true }).count(), 0);
    assert.equal(posts.length, pendingReviewPosts);
    heldReads[1].release();
    await page.getByText("Current task records loaded. Review their status before another action.", { exact: true }).waitFor();
    await page.locator("#ftb-status-done").click();
    assert.equal(await taskRow.getByRole("checkbox", { name: /^Reopen task:/ }).isDisabled(), false);
    assert.equal(posts.length, pendingReviewPosts, "neither read replays the unknown POST");
    outcome = "saved";
    await taskRow.getByRole("checkbox", { name: /^Reopen task:/ }).click();
    await page.getByText("Task reopened.", { exact: true }).waitFor();
    await page.locator("#ftb-status-active").click();
    // Governed completed outcomes stay recorded. Follow-up uses the existing
    // local New task editor, including offline drafts, without a canonical POST.
    models.LastResort.canonical = { source: "governed-registers", projection: "workspace-v1" };
    models.LastResort.revision++;
    await page.evaluate(() => window.fixtureRead());
    await taskRow.getByText("Details", {exact:true}).click();
    await taskRow.getByText("Record completion evidence in Notes before completing this task.", { exact: true }).waitFor();
    models.LastResort.tasks[0].status = "done";
    models.LastResort.tasks[0].version++; models.LastResort.revision++;
    await page.evaluate(() => window.fixtureRead());
    await page.locator("#ftb-status-done").click();
    const beforeFollowup = posts.length;
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await taskRow.getByRole("checkbox", { name: /^Reopen task:/ }).isDisabled(), true);
      if (!await taskRow.locator("details").evaluate(node => node.open)) await taskRow.getByText("Details", {exact:true}).click();
      await taskRow.getByText("Completed outcomes stay recorded. Create a follow-up for new work.", { exact: true }).waitFor();
      if (width === 390) await page.evaluate(() => window.fixtureOffline());
      await taskRow.getByRole("button", { name: "Create follow-up task", exact: true }).click();
      const followup = page.getByRole("dialog");
      await followup.locator('input[name="title"]').waitFor();
      assert.notEqual(await followup.locator('input[name="title"]').inputValue(), models.LastResort.tasks[0].title);
      assert.equal(posts.length, beforeFollowup);
      if (width === 390) assert.equal(await followup.getByRole("button", { name: "Save task", exact: true }).isDisabled(), true);
      await page.keyboard.press("Escape");
    }
    delete models.LastResort.canonical;
    models.LastResort.tasks[0].status = "todo";
    models.LastResort.tasks[0].version++; models.LastResort.revision++;
    await page.evaluate(() => window.fixtureOnline());
    await page.evaluate(() => window.fixtureRead());
    await page.evaluate(() => window.fixtureShow("LastResort"));
    await page.evaluate(() => window.fixtureOnline());
    await page.locator("#forge-capture").fill("Canonical save with competing durable evidence");
    outcome = "delayed";
    const beforeRace = posts.length;
    await page.locator("#forge-capture").press("Enter");
    for (let attempts = 0; !releaseResponse && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseResponse);
    const oldResponseRevision = models.LastResort.revision;
    models.LastResort.revision++;
    const otherTab = await browser.newPage();
    await otherTab.goto(origin + "/lastresort/forge/ideas");
    await otherTab.waitForFunction(() => window.fixtureReady);
    assert.equal((await otherTab.evaluate(value => window.fixturePersist(value), models.LastResort)).ok, true);
    await otherTab.close();
    await page.evaluate(() => { window.fixtureRevisions = []; });
    releaseResponse(); releaseResponse = undefined;
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
    const revisions = await page.evaluate(() => window.fixtureRevisions);
    assert.equal(revisions.includes(oldResponseRevision), false, "the stale command response is never published locally");
    assert.equal(revisions.at(-1), models.LastResort.revision);
    assert.equal(posts.length, beforeRace + 1, "a durable cache race does not retry the confirmed canonical command");
    assert.equal(await page.locator(".forge-capture").getByText(/We couldn’t confirm the save/).count(), 0);
    outcome = "saved";
    await page.locator("#forge-capture").fill("Confirmed save with failed local cleanup");
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function(...args) {
        if (this.name === "drafts") { this.transaction.abort(); return undefined; }
        return original.apply(this, args);
      };
      window.fixtureRestoreDeletes = () => { IDBObjectStore.prototype.delete = original; };
    });
    const beforeCleanupFailure = posts.length;
    await page.locator("#forge-capture").press("Enter");
    await page.getByText(/Record saved; local cleanup failed/).waitFor();
    const retainedConfirmed = await page.evaluate(() => window.fixtureReadCapture());
    assert.ok(retainedConfirmed.value.savedAt);
    assert.equal(retainedConfirmed.value.fields.__vortonConfirmedRequest, posts.at(-1).requestId);
    assert.equal(retainedConfirmed.value.fields.__vortonUnknownRequest, undefined);
    await page.evaluate(() => window.fixtureRestoreDeletes());
    await page.reload(); await page.locator("#forge-capture").waitFor();
    await page.getByText("This record was saved. Another canonical save is blocked. Discarding removes the local draft and any unsent edits; saved records remain intact.", { exact: true }).waitFor();
    assert.equal(await page.getByText(/We couldn’t confirm the save/).count(), 0);
    await page.locator("#forge-capture").fill("Continued editing after cleanup failure");
    const persistedBeforeBlockedSubmit = await waitForDraft(page,"forge-capture-v1","new",{title:"Continued editing after cleanup failure"});
    const beforeBlockedSubmit = await page.evaluate(async () => ({draft:await window.fixtureReadCapture(),input:document.querySelector('#forge-capture').value}));
    await page.locator("#forge-capture").press("Enter");
    const afterBlockedSubmit = await page.evaluate(async () => ({draft:await window.fixtureReadCapture(),input:document.querySelector('#forge-capture').value}));
    t.diagnostic(`Confirmed-save recovery before/after blocked Enter: ${JSON.stringify({matched:persistedBeforeBlockedSubmit,before:beforeBlockedSubmit,after:afterBlockedSubmit})}`);
    assert.equal(posts.length, beforeCleanupFailure + 1, "cleanup pending never replays the confirmed save");
    assert.equal(afterBlockedSubmit.draft.value.fields.title, "Continued editing after cleanup failure");
    const discardUnsent = page.getByRole("button", { name: "Discard local draft and unsent edits", exact: true });
    await discardUnsent.waitFor();
    assert.equal(await page.locator("#forge-capture").inputValue(), "Continued editing after cleanup failure");
    await discardUnsent.click();
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
    assert.equal((await page.evaluate(() => window.fixtureReadCapture())).value, undefined);
    await page.evaluate(() => window.fixtureOnline());
    await page.locator("#forge-capture").fill("New capture after recovered cleanup");
    await waitForDraft(page,"forge-capture-v1","new",{title:"New capture after recovered cleanup"});
    await page.locator("#forge-capture").press("Enter");
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
    assert.equal(posts.length, beforeCleanupFailure + 2);
    await page.locator("#forge-capture").fill("Confirmed save with competing local draft");
    outcome = "delayed";
    await page.locator("#forge-capture").press("Enter");
    for (let attempts = 0; !releaseResponse && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseResponse);
    const cleanupTab = await browser.newPage();
    await cleanupTab.goto(origin + "/lastresort/forge/ideas");
    await cleanupTab.waitForFunction(() => window.fixtureReady);
    const winner = await cleanupTab.evaluate(() => window.fixtureReplaceCapture());
    assert.equal(winner.ok, true);
    const winnerPosts = posts.length;
    releaseResponse(); releaseResponse = undefined;
    await page.getByText(/Record saved\. Another form changed the local draft/).waitFor();
    await page.locator("#forge-capture").press("Enter");
    await page.getByRole("button", { name: "Discard local draft and unsent edits", exact: true }).click();
    assert.equal(posts.length, winnerPosts);
    assert.deepEqual((await cleanupTab.evaluate(() => window.fixtureReadCapture())).value, winner.value,
      "failed cleanup CAS never overwrites or deletes another tab's winner");
    await cleanupTab.close();
    await page.reload(); await page.locator("#forge-capture").waitFor();
    assert.equal(await page.locator("#forge-capture").inputValue(), "Other tab cleanup winner");
    await page.getByRole("button", { name: "Discard local draft", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
    outcome = "saved";
    await page.evaluate(() => window.fixtureOnline());
    // Hold the first save until typing advances its generation. The second
    // serialized save must use the first success timestamp, not null.
    const draftTab = await browser.newPage();
    await draftTab.goto(origin + "/lastresort/forge/ideas");
    await draftTab.locator("#forge-capture").waitFor();
    await draftTab.evaluate(() => window.fixtureHoldDraftWrites());
    await page.evaluate(() => window.fixtureTrackDraftWrites());
    await page.locator("#forge-capture").fill("First in-flight autosave");
    await page.waitForFunction(() => window.fixtureDraftWrites > 0);
    await page.locator("#forge-capture").fill("Newer same-form typing");
    await draftTab.evaluate(() => window.fixtureReleaseDraftWrites());
    await waitForDraft(page,"forge-capture-v1","new",{title:"Newer same-form typing"});
    const latestDraft = await page.evaluate(() => window.fixtureReadCapture());
    assert.equal(latestDraft.value.fields.title, "Newer same-form typing");
    await draftTab.locator("#forge-capture").fill("Conflicting other-tab text");
    await draftTab.getByText(/Another form changed this saved draft/).waitFor();
    assert.equal(await draftTab.locator("#forge-capture").inputValue(), "Conflicting other-tab text");
    assert.deepEqual(await draftTab.evaluate(() => window.fixtureReadCapture()), latestDraft);
    await draftTab.close();
    await page.locator(".forge-capture").getByRole("button", { name: "Discard local draft", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");

    // Exit the entire browser while the POST response is pending. Its durable
    // hint must already exist, without storing a replayable command or token.
    await page.locator("#forge-capture").fill("Process exits during POST");
    outcome = "delayed";
    await page.locator("#forge-capture").press("Enter");
    for (let attempts = 0; !releaseResponse && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(releaseResponse);
    const prepared = await page.evaluate(() => window.fixtureReadCapture());
    assert.equal(prepared.value.fields.__vortonUnknownRequest, posts.at(-1).requestId);
    assert.equal(prepared.value.fields.__vortonAttemptTitle, "Process exits during POST");
    assert.equal(JSON.stringify(prepared).includes("online-only-token"), false);
    assert.equal("action" in prepared.value.fields, false);
    const pendingCount = posts.length;
    await browser.close(); browser = undefined;
    releaseResponse(); releaseResponse = undefined;
    page = await open(390);
    await page.locator(".forge-capture").getByText(/We couldn.t confirm the save\. Check current records before trying again/).waitFor();
    await page.locator("#forge-capture").press("Enter");
    assert.equal(posts.length, pendingCount);
    await page.evaluate(() => window.fixtureOnline());
    await page.locator(".forge-capture").getByRole("button", { name: "Review current records" }).click();
    await page.locator(".forge-capture details summary").click();
    assert.match(await page.locator(".forge-capture pre").innerText(), /Process exits during POST/);
    await page.locator(".forge-capture").getByRole("button", { name: "Discard local draft", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
    outcome = "saved";
    await page.locator("#forge-capture").fill("Read clear retains this draft");
    await waitForDraft(page,"forge-capture-v1","new",{title:"Read clear retains this draft"});
    assert.equal((await page.evaluate(() => window.fixtureClearReads())).ok, true);
    const beforeClearAttempt = posts.length;
    await page.locator("#forge-capture").press("Enter");
    await page.locator(".forge-capture").getByText("Saved workspace scope changed. Reconnect and review before saving.", { exact: true }).waitFor();
    assert.equal(posts.length, beforeClearAttempt);
    const retained = await page.evaluate(() => window.fixtureReadCapture());
    assert.equal(retained.ok, true);
    assert.equal(retained.value.fields.title, "Read clear retains this draft");
    for (const mode of ["memory", "legacy"]) {
      const memoryPage = await browser.newPage();
      await memoryPage.goto(origin + "/lastresort/forge/ideas?" + mode + "=1");
      await memoryPage.locator("#forge-capture").fill("Foreground " + mode + " save");
      outcome = "delayed";
      await memoryPage.locator("#forge-capture").press("Enter");
      for (let attempts = 0; !releaseResponse && attempts < 1500; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(releaseResponse, mode + " must still send an authorized foreground command");
      await memoryPage.locator(".forge-capture").getByText(/recovery after closing or process loss is unavailable/).waitFor();
      releaseResponse(); releaseResponse = undefined;
      await memoryPage.waitForFunction(() => document.querySelector('#forge-capture')?.value === "");
      await memoryPage.close(); outcome = "saved";
    }
    t.diagnostic("Real IndexedDB, a fresh Chromium process, desktop/mobile native forms and explicit canonical POST outcomes verified.");
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
