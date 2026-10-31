import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "vite";
import { offlineBuild, prepareOfflineShell, prepareReloadShell } from "../scripts/pwa-build.mjs";
import vm from "node:vm";

test("reload bootstrap makes one fresh navigation and preserves route, filters and fragment", () => {
  const html = prepareReloadShell('<html><head></head></html>');
  assert.equal(prepareReloadShell(html), html);
  const script = /<script id="vorton-reload">(.*?)<\/script>/.exec(html)[1];
  const run = (href, type, controlled = true) => {
    const calls = [];
    vm.runInNewContext(script, { URL, location: { href, replace: url => calls.push(["navigate", url]) },
      history: { state: null, replaceState: (_, __, url) => calls.push(["canonical", url]) },
      performance: { getEntriesByType: () => [{ type }] }, navigator: { serviceWorker: { controller: controlled ? {} : null } } });
    return calls;
  };
  const url = 'https://fixture.test/aubos/forge/tasks?q=work#task-one';
  assert.deepEqual(run(url, "navigate"), []);
  assert.deepEqual(run(url, "reload", false), []);
  const marked = 'https://fixture.test/aubos/forge/tasks?q=work&__vorton_reload=1#task-one';
  assert.deepEqual(run(url, "reload"), [["navigate", marked]]);
  assert.deepEqual(run(marked, "reload"), [["canonical", url]], "Even an offline cached marked response cannot loop");
});

test("recovery uses the ordinary route and bounds stalled browser storage", async () => {
  const html = '<html><head><script type="module" src="/assets/app.js"></script></head></html>';
  const updated = prepareOfflineShell(html, "private");
  assert.ok(updated.indexOf('id="vorton-forge-update"') < updated.indexOf('type="module"'));
  assert.equal(prepareOfflineShell(updated, "private"), updated);
  assert.equal(prepareOfflineShell(html, "portable"), html);
  const script = /<script id="vorton-forge-update">(.*?)<\/script>/.exec(updated)[1];
  const calls = [];
  const context = { URLSearchParams, setTimeout: fn => setTimeout(fn,10), clearTimeout, location: { pathname: "/aubos/update-forge", search: "", replace: url => calls.push(url) }, history: { state: null, replaceState: (_, __, url) => calls.push(url) }, navigator: { serviceWorker: { getRegistration: () => new Promise(() => {}) } } };
  vm.runInNewContext(script, context);
  assert.deepEqual(calls,[]);
  await context.__vortonCodeRecovery;
  assert.deepEqual(calls,["/aubos/update-forge?__vorton_entry=1"]);
  context.location.search="?__vorton_entry=1";calls.length=0;
  vm.runInNewContext(script,context);
  assert.deepEqual(calls,["/aubos/forge/tasks"]);
  context.location.pathname = "/aubos/forge/ideas"; calls.length = 0;
  vm.runInNewContext(script, context);
  assert.deepEqual(calls,[],"Ordinary routes are preserved");
});

test("closing recovery cannot restore a legacy worker in the next direct tab", { skip: !process.env.OFFLINE_BROWSER && process.env.OFFLINE_ENGINE !== "webkit", timeout: 30000 }, async () => {
  const { createServer } = await import("node:http");
  const { chromium, webkit } = await import("playwright-core");
  let current = false;
  const legacyWorker = `self.addEventListener('install',e=>e.waitUntil(caches.open('legacy-code').then(c=>c.put('/old',new Response('<h1>Old app</h1>',{headers:{'content-type':'text/html'}})))));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/aubos/forge/tasks')e.respondWith(caches.open('legacy-code').then(c=>c.match('/old')));});`;
  const server = createServer((req,res) => {
    const url = new URL(req.url,"http://fixture");
    res.setHeader("Cache-Control","no-store");
    if(url.pathname==="/sw.js"){res.setHeader("Content-Type","text/javascript");res.end(current ? `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('message',e=>e.ports[0]?.postMessage('current'));` : legacyWorker);return;}
    res.setHeader("Content-Type","text/html");
    res.end(current ? prepareOfflineShell('<html><head></head><body><h1>Current app</h1><script>if(!globalThis.__vortonCodeRecovery)navigator.serviceWorker.register("/sw.js",{updateViaCache:"none"}).then(r=>r.update());</script></body></html>',"private") : '<html><head></head><body><h1>Old app</h1><script>navigator.serviceWorker.register("/sw.js");</script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const engine = process.env.OFFLINE_ENGINE === "webkit" ? webkit : chromium;
  const browser=await engine.launch(engine === chromium ? {executablePath:process.env.OFFLINE_BROWSER} : {});
  try {
    const context=await browser.newContext();const original=await context.newPage();
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.stack ?? error.message)));
    original.on("pageerror", error => errors.push(error.stack ?? error.message));
    await original.goto(origin+'/aubos/forge/tasks');
    await original.evaluate(()=>navigator.serviceWorker.ready);
    await original.reload();await original.getByRole('heading',{name:'Old app',exact:true}).waitFor();
    await original.evaluate(()=>localStorage.setItem('draft-sentinel','keep my unfinished draft'));
    current=true;
    const recovery=await context.newPage();await recovery.goto(origin+'/aubos/update-forge');
    await recovery.waitForURL(origin+'/aubos/forge/tasks');
    await recovery.evaluate(async()=>{for(let i=0;i<100;i++){const r=await navigator.serviceWorker.getRegistration('/');if(r?.active){const current=await new Promise(resolve=>{const c=new MessageChannel();const timer=setTimeout(()=>{c.port1.close();resolve(false);},100);c.port1.onmessage=e=>{clearTimeout(timer);c.port1.close();resolve(e.data==='current');};r.active.postMessage('version',[c.port2]);});if(current)return;}await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Update did not activate');});
    await recovery.close();
    const direct=await context.newPage();await direct.goto(origin+'/aubos/forge/tasks');
    await direct.getByRole('heading',{name:'Current app',exact:true}).waitFor();
    assert.equal(await direct.evaluate(()=>localStorage.getItem('draft-sentinel')),'keep my unfinished draft');
    assert.equal(await direct.evaluate(()=>caches.has('legacy-code')),true,'Recovery preserves code caches');
    await original.getByRole('heading',{name:'Old app',exact:true}).waitFor();
    assert.deepEqual(errors, [], "Recovery and direct navigation must not produce script errors");
  } finally { await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});

test("offline inventory binds emitted lazy code and fonts but excludes copied private data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vorton-offline-build-"));
  try {
    await mkdir(path.join(root, "public/server"), { recursive: true });
    await writeFile(path.join(root, "public/private.json"), '{"private":"must not cache"}');
    await writeFile(path.join(root, "public/server/rolodex.mjs"), "private server sentinel");
    await writeFile(path.join(root, "public/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(root, "index.html"), '<html><head></head><body><script type="module" src="/main.js"></script></body></html>');
    await writeFile(path.join(root, "main.js"), 'import "./style.css"; window.loadTool = () => import("./tool.js");');
    await writeFile(path.join(root, "tool.js"), 'export const tool = "offline lazy tool";');
    await writeFile(path.join(root, "style.css"), '@font-face {font-family: Test; src: url("./font.woff2")}');
    await writeFile(path.join(root, "font.woff2"), "synthetic font bytes");
    await build({ root, configFile: false, logLevel: "silent", build: { assetsInlineLimit: 0 }, plugins: [
      { name: "storage-worker-fixture", generateBundle() {
        this.emitFile({ type: "asset", fileName: "assets/sqlite-worker-fixture.js", source: "/* storage worker fixture */" });
        this.emitFile({ type: "asset", fileName: "assets/sqlite3-fixture.wasm", source: "synthetic wasm bytes" });
      } },
      offlineBuild({ variant: "private", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] }),
    ] });
    const dist = path.join(root, "dist");
    const inventory = JSON.parse(await readFile(path.join(dist, "offline-assets.json"), "utf8"));
    const shell = await readFile(path.join(dist, "index.html"), "utf8");
    assert.match(shell, /id="vorton-reload" src="\/assets\/vorton-reload-[a-f0-9]+\.js"/);
    assert.ok(!/<script[^>]*>\s*[^<\s]/.test(shell), "Upgrade bootstrap executes under script-src self");
    const urls = inventory.entries.map(entry => entry.url);
    assert.ok(urls.some(url => /tool-.*\.js$/.test(url)));
    assert.ok(urls.some(url => /font-.*\.woff2$/.test(url)));
    assert.ok(urls.includes("/icon.svg"));
    assert.ok(urls.includes("/manifest.webmanifest"));
    assert.ok(!urls.some(url => /private|rolodex|server/.test(url)));
    // The deliberately copied files still exist; exclusion is the inventory's
    // responsibility, not an accidental absence from the fixture.
    assert.match(await readFile(path.join(dist, "private.json"), "utf8"), /must not cache/);
    for (const entry of inventory.entries) {
      const bytes = await readFile(path.join(dist, entry.url === "/offline-shell.html" ? "index.html" : entry.url.slice(1)));
      assert.equal(entry.size, bytes.length);
      assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
    assert.equal(inventory.schema, 2);
    assert.equal(inventory.entries.find(entry => entry.url === "/offline-shell.html").role, "boot");
    assert.equal(inventory.entries.find(entry => /tool-.*\.js$/.test(entry.url)).role, "offline");
    assert.equal(inventory.entries.find(entry => /font-.*\.woff2$/.test(entry.url)).role, "optional");
    assert.equal(inventory.entries.find(entry => /\.css$/.test(entry.url)).role, "boot");
    assert.equal(inventory.entries.find(entry => /sqlite-worker-fixture\.js$/.test(entry.url)).role, "boot");
    assert.equal(inventory.entries.find(entry => /sqlite3-fixture\.wasm$/.test(entry.url)).role, "boot");
    assert.equal(inventory.entries.find(entry => /vorton-reload-.*\.js$/.test(entry.url)).role, "boot");
    assert.equal(inventory.buildId, createHash("sha256").update(JSON.stringify({ schema: 2, variant: "private", entries: inventory.entries })).digest("hex"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
