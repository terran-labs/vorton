import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderWorker as renderPwaWorker } from "./pwa-worker-template.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Compatibility entry for old bookmarks. Bound retirement of the obsolete
// registration, then enter fresh code through a route legacy workers do not cache.
export function prepareOfflineShell(source, variant) {
  const html = String(source);
  if (variant !== "private" || html.includes('id="vorton-forge-update"')) return html;
  return html.replace("<head>", `<head><script id="vorton-forge-update">if(location.pathname==="/aubos/update-forge"){if(new URLSearchParams(location.search).has("__vorton_entry")){globalThis.__vortonRecoveryEntry=true;history.replaceState(history.state,"","/aubos/forge/tasks");}else globalThis.__vortonCodeRecovery=(async()=>{let timer,expired=false;try{await Promise.race([(async()=>{const r=await navigator.serviceWorker?.getRegistration("/");const w=r?.active||r?.waiting||r?.installing;if(!expired&&r&&r.scope===location.origin+"/"&&w?.scriptURL===location.origin+"/sw.js")await r.unregister();})(),new Promise(resolve=>{timer=setTimeout(resolve,4000);})]);}catch{}finally{expired=true;clearTimeout(timer);location.replace("/aubos/update-forge?__vorton_entry=1");}})();}</script>`);
}

// Safari may label a reload's service-worker request as default-cache. Detect
// explicit reload in the document and make one marked navigation that every
// current worker handles network-first. Strip the marker before application
// routing; the marked response never redirects again, including offline.
export function prepareReloadShell(source) {
  const html = String(source);
  if (html.includes('id="vorton-reload"')) return html;
  return html.replace("<head>", `<head><script id="vorton-reload">(()=>{const u=new URL(location.href);if(u.searchParams.has("__vorton_reload")){u.searchParams.delete("__vorton_reload");history.replaceState(history.state,"",u.href);}else if(performance.getEntriesByType("navigation")[0]?.type==="reload"&&navigator.serviceWorker?.controller){u.searchParams.set("__vorton_reload","1");location.replace(u.href);}})();</script>`);
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/** Only emitted browser code and explicitly selected public icons enter this list.
 * Never discover files by walking publicDir: private builds contain personal data.
 */
export function createOfflineInventory(variant, files, roles) {
  if (!["private", "portable"].includes(variant)) throw new Error("Invalid PWA variant");
  const entries = [...files].map(([url, source]) => {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(url) || url.split("/").includes("..")) {
      throw new Error(`Invalid offline asset URL: ${url}`);
    }
    const bytes = Buffer.from(source);
    const contentType = mime[path.extname(url)];
    if (!contentType) throw new Error(`Unsupported offline asset: ${url}`);
    return { url, sha256: sha256(bytes), size: bytes.length, contentType, ...(roles ? { role: roles.get(url) ?? "optional" } : {}) };
  }).sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  if (!entries.some((entry) => entry.url === "/offline-shell.html")) {
    throw new Error("Offline shell is missing");
  }
  const identity = { schema: roles ? 2 : 1, variant, entries };
  const buildId = sha256(JSON.stringify(identity));
  const source = JSON.stringify({ ...identity, buildId });
  return { source, buildId, inventorySha256: sha256(source), entries };
}

export function offlineBuild({ variant, icons, renderWorker = renderPwaWorker }) {
  let config;
  return {
    name: "vorton-offline-build",
    enforce: "post",
    apply: "build",
    configResolved(value) { config = value; },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        const index = bundle["index.html"];
        if (!index || index.type !== "asset") throw new Error("PWA build requires index.html");
        index.source = prepareReloadShell(prepareOfflineShell(index.source, variant));
        const bootstraps = new Map();
        index.source = String(index.source).replace(/<script id="(vorton-reload|vorton-forge-update)">([\s\S]*?)<\/script>/g, (_tag, id, source) => {
          const filename = `${variant === "private" ? "assets" : "demo-assets"}/${id}-${sha256(source).slice(0, 16)}.js`;
          bootstraps.set(`/${filename}`, source);
          this.emitFile({ type: "asset", fileName: filename, source });
          return `<script id="${id}" src="/${filename}"></script>`;
        });
        const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid application version");
        index.source = String(index.source).replace("<head>", `<head><meta name="vorton-version" content="${version}">`);
        const shellId = sha256(index.source);
        index.source = String(index.source).replace("<head>", `<head><meta name="vorton-shell" content="${shellId}">`);
        const files = new Map([["/offline-shell.html", index.source]]);
        for (const [url, source] of bootstraps) files.set(url, source);
        for (const output of Object.values(bundle)) {
          // PublicDir copies and the separately built server adapter are not in
          // this browser bundle. Restrict extensions as an additional boundary.
          if (/\.(?:js|css|wasm|woff2|svg|png|ico)$/.test(output.fileName)) {
            files.set(`/${output.fileName}`, output.type === "chunk" ? output.code : output.source);
          }
        }
        for (const icon of icons) {
          const relative = icon.src.replace(/^\//, "");
          if (relative.split("/").includes("..") || relative.includes("\\")) throw new Error("Invalid icon path");
          files.set(icon.src, await readFile(path.join(config.publicDir, relative)));
        }
        const manifest = JSON.stringify({
          id: "/", name: "Vorton", short_name: "Vorton", scope: "/",
          start_url: "/?launch=pwa", display: "standalone",
          background_color: "#e2e2ee", theme_color: "#e2e2ee", icons,
        });
        files.set("/manifest.webmanifest", manifest);
        const roles = new Map([...files.keys()].map(url => [url, /\.(?:js|css|wasm)$/.test(url) ? "offline" : "optional"]));
        const visit = filename => {
          const url = "/" + filename;
          if (roles.get(url) === "boot") return;
          if (files.has(url)) roles.set(url, "boot");
          const output = bundle[filename];
          if (output?.type === "chunk") {
            for (const dependency of output.imports) visit(dependency);
            for (const css of output.viteMetadata?.importedCss ?? []) visit(css);
          }
        };
        roles.set("/offline-shell.html", "boot");
        // Vite emits worker entrypoints outside the document import graph.
        // A replacement shell must still be able to open the durable outbox.
        for (const url of files.keys()) if (/\/sqlite-worker-[^/]+\.js$/.test(url) || /\.wasm$/.test(url)) roles.set(url, "boot");
        for (const output of Object.values(bundle)) if (output.type === "chunk" && output.isEntry) visit(output.fileName);
        for (const match of String(index.source).matchAll(/(?:src|href)=["']\/([^"']+\.(?:js|css))["']/g)) visit(match[1]);
        const inventory = createOfflineInventory(variant, files, roles);
        this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest });
        this.emitFile({ type: "asset", fileName: "offline-assets.json", source: inventory.source });
        if (renderWorker) this.emitFile({ type: "asset", fileName: "sw.js", source: renderWorker({ variant, buildId: inventory.buildId, inventorySha256: inventory.inventorySha256, shellId, version }) });
      },
    },
  };
}
