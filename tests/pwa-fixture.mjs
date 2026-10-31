import path from "node:path";
import os from "node:os";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { createCoreServer } from "../server/core-http.mjs";
import { pwaHash } from "../server/pwa-assets.mjs";
import { renderWorker } from "../scripts/pwa-worker-template.mjs";

export function buildFixture(variant = "portable", version = "one", staged = false) {
  const asset = variant === "private" ? "assets" : "demo-assets";
  const files = new Map([
    ["/offline-shell.html", { body: `<!doctype html><title>${version}</title><script src="/${asset}/app-${version}.js"></script>`, contentType: "text/html; charset=utf-8" }],
    [`/${asset}/app-${version}.js`, { body: `globalThis.fixture=${JSON.stringify(version)};`, contentType: "text/javascript; charset=utf-8" }],
    [`/${asset}/font-${version}.woff2`, { body: "synthetic font", contentType: "font/woff2" }],
    ["/manifest.webmanifest", { body: JSON.stringify({ id: "/", start_url: "/", scope: "/", name: "Synthetic fixture", display: "standalone" }), contentType: "application/manifest+json" }],
  ]);
  if (staged) files.set(`/${asset}/lazy-${version}.js`, { body: "globalThis.lazy=true;", contentType: "text/javascript; charset=utf-8" });
  const schema = staged ? 2 : 1;
  const entries = [...files].map(([url, value]) => ({ url, sha256: pwaHash(value.body), size: Buffer.byteLength(value.body), contentType: value.contentType,
    ...(staged ? { role: url === "/offline-shell.html" || url.includes("/app-") ? "boot" : url.endsWith(".js") ? "offline" : "optional" } : {}) }))
    .sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  const buildId = pwaHash(JSON.stringify({ schema, variant, entries }));
  const inventory = { schema, variant, entries, buildId };
  const inventoryBody = JSON.stringify(inventory);
  const config = { variant, buildId, inventorySha256: pwaHash(inventoryBody) };
  files.set("/offline-assets.json", { body: inventoryBody, contentType: "application/json" });
  files.set("/sw.js", { body: renderWorker(config), contentType: "text/javascript" });
  return { files, inventory, config };
}

export async function hostFixture(t, variant = "portable", options = {}, privateServer) {
  // The portable fixture never imports the private adapter. Private coverage
  // supplies its factory from a test excluded from the portable publication.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "vorton-pwa-"));
  const dist = path.join(root, variant === "private" ? "aubos/dashboard/web/dist-vite" : "dist");
  const build = buildFixture(variant);
  await mkdir(dist, { recursive: true });
  for (const [url, file] of build.files) {
    const filename = path.join(dist, url === "/offline-shell.html" ? "index.html" : url.slice(1));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, file.body);
  }
  const app = variant === "private"
    ? privateServer({ root, port: 0, frontend: "vite", enabledProfiles: ["FreedOS", "LastResort"], ...options })
    : createCoreServer({ root, port: 0, ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.hosts.add(new URL(base).host); app.allowed.add(base);
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { ...build, ...app, root, dist, base };
}

export function raw(base, route, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(base), { path: route, headers, method }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}

