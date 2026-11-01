import { validatePwaInventory } from "../server/pwa-assets.mjs";

function worker(config, validateInventory) {
  const contract = "vorton.offline-control.v1";
  const prefix = `vorton-code-v1:${config.variant}:`;
  const name = prefix + config.buildId;
  const origin = self.location.origin;
  const markerUrl = origin + "/__vorton_pwa__/complete";
  const inventoryUrl = origin + "/offline-assets.json";
  // A durable code-only tombstone fences installs that were running at forget.
  const controlName = `vorton-pwa-control-v1:${config.variant}`;
  const epochUrl = origin + "/__vorton_pwa__/epoch";
  const activeUrl = origin + "/__vorton_pwa__/active";
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  const epoch = async () => (await (await caches.open(controlName)).match(epochUrl))?.text().then(value => value) ?? "";
  let variantMatches = true;
  let filling;
  let fillController;
  let downloadError;
  let lastVersionCheck = 0;
  const require = (value, message) => { if (!value) throw new Error(message); };
  async function fetchBounded(input, options = {}) {
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    let timer;
    try {
      return await Promise.race([
        fetch(input, { ...options, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Offline download timed out")); }, 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function boundedBytes(response, maximum) {
    require(response.status === 200 && response.type !== "opaque" && !response.redirected, "Invalid offline response");
    const reader = response.body?.getReader();
    require(reader, "Missing offline response body");
    const chunks = []; let length = 0, timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Offline response timed out")), 15000); });
    try {
      while (true) {
        const { value, done } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        length += value.length;
        require(length <= maximum, "Offline response exceeds bound");
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { clearTimeout(timer); }
    const bytes = new Uint8Array(length); let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    return bytes;
  }

  async function inventory(response) {
    const bytes = await boundedBytes(response, 512 * 1024);
    require(await hash(bytes) === config.inventorySha256, "Offline inventory digest mismatch");
    const value = validateInventory(JSON.parse(new TextDecoder().decode(bytes)), config.variant);
    require(value.buildId === config.buildId &&
      await hash(new TextEncoder().encode(JSON.stringify({ schema: value.schema, variant: value.variant, entries: value.entries }))) === config.buildId,
      "Offline build mismatch");
    return { value, bytes };
  }

  async function verified(response, entry) {
    require(response && response.headers.get("content-type")?.split(";")[0].trim() === entry.contentType.split(";")[0].trim(), "Offline content type mismatch");
    const headers = new Headers(response.headers);
    const bytes = await boundedBytes(response, entry.size);
    require(bytes.length === entry.size && await hash(bytes) === entry.sha256, "Offline asset digest mismatch");
    // Cached bytes are decoded. Retaining a wire encoding/length would corrupt delivery.
    headers.delete("content-encoding"); headers.delete("content-length");
    return new Response(bytes, { status: 200, headers });
  }

  async function ready(cacheName = name) {
    // The marker certifies verified startup installation. Coverage below
    // separately checks the remaining offline files and later eviction.
    if (!(await caches.keys()).includes(cacheName)) return null;
    const cache = await caches.open(cacheName);
    const markerResponse = await cache.match(markerUrl);
    if (!markerResponse) return null;
    const marker = await markerResponse.json();
    if (marker.variant !== config.variant || marker.buildId !== cacheName.slice(prefix.length) ||
        marker.epoch !== await epoch()) return null;
    return { cache, marker };
  }

  async function savedInventory(state) {
    const bytes = await boundedBytes(await state.cache.match(inventoryUrl), 512 * 1024);
    require(await hash(bytes) === state.marker.inventorySha256, "Saved inventory mismatch");
    const value = validateInventory(JSON.parse(new TextDecoder().decode(bytes)), config.variant);
    require(value.buildId === state.marker.buildId, "Saved build mismatch");
    return value;
  }

  const bootEntries = value => value.entries.filter(entry => value.schema === 1 || entry.role === "boot");
  async function coverage(state) {
    if (!state) return { ready: false, codeReady: false, pendingAssets: 0, optionalPending: 0 };
    const value = await savedInventory(state);
    let boot = 0, offline = 0, optional = 0;
    await Promise.all(value.entries.map(async entry => {
      try { await verified(await state.cache.match(origin + entry.url), entry); return; }
      catch { /* Missing or corrupt entries need preparation. */ }
      if (value.schema === 1 || entry.role === "boot") boot++;
      else if (entry.role === "offline") offline++;
      else optional++;
    }));
    return { ready: boot + offline === 0, codeReady: boot === 0, pendingAssets: boot + offline + optional, optionalPending: optional };
  }

  function prepareOffline(state) {
    if (filling) return filling;
    const controller = new AbortController();
    fillController = controller;
    downloadError = undefined;
    filling = (async () => {
      const value = await savedInventory(state), startEpoch = await epoch(), started = Date.now();
      const priority = entry => value.schema === 1 || entry.role === "boot" ? 0 : entry.role === "offline" ? 1 : 2;
      const entries = [...value.entries].sort((a, b) => priority(a) - priority(b));
      for (let offset = 0; offset < entries.length && Date.now() - started < 20000; offset += 4) {
        if (controller.signal.aborted || await epoch() !== startEpoch) return;
        const results = await Promise.allSettled(entries.slice(offset, offset + 4).map(async entry => {
          try { await verified(await state.cache.match(origin + entry.url), entry); return; }
          catch { /* Replace missing or corrupt cached bytes. */ }
          const response = await fetchBounded(origin + entry.url, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal });
          const checked = await verified(response, entry);
          require(!controller.signal.aborted && await epoch() === startEpoch, "Offline download was superseded");
          await state.cache.put(origin + entry.url, checked);
        }));
        if (!controller.signal.aborted && results.some(result => result.status === "rejected"))
          downloadError = "Some offline files could not be saved. Retry when connected.";
      }
    })().catch(() => {
      if (!controller.signal.aborted) downloadError = "Offline download did not finish. Retry when connected.";
    }).finally(() => { controller.abort(); fillController = undefined; filling = undefined; });
    return filling;
  }

  async function retainedAsset(url) {
    for (const key of await caches.keys()) {
      if (!key.startsWith(prefix) || key === name) continue;
      try {
        const state = await ready(key);
        if (!state) continue;
        const value = await savedInventory(state);
        const entry = value.entries.find(item => item.url === url);
        if (entry) return await verified(await state.cache.match(origin + url), entry);
      } catch { /* An incomplete old cache cannot supply executable code. */ }
    }
    return null;
  }

  self.addEventListener("install", event => {
    // Historical clients cannot perform the new document's handshake. Request
    // activation at the installed boundary as well, preserving their documents.
    const installing = self.registration?.installing;
    if (installing) {
      const changed = () => {
        if (installing.state === "installed") void self.skipWaiting();
        if (["installed", "redundant"].includes(installing.state)) installing.removeEventListener("statechange", changed);
      };
      installing.addEventListener("statechange", changed);
    }
    event.waitUntil((async () => {
    const startEpoch = await epoch();
    const response = await fetchBounded(inventoryUrl, { cache: "no-store", credentials: "same-origin", redirect: "error" });
    require(response.headers.get("x-vorton-variant") === config.variant &&
      response.headers.get("x-vorton-build-id") === config.buildId, "Offline host build mismatch");
    const { value, bytes } = await inventory(response);
    // A same-build reinstall must not damage an already complete active cache.
    const complete = await ready();
    if (complete) {
      try {
        for (const entry of bootEntries(value)) await verified(await complete.cache.match(origin + entry.url), entry);
        await self.skipWaiting(); return;
      } catch { /* Eviction or corruption invalidates the marker. Repair below. */ }
    }
    const cache = await caches.open(name);
    try {
      await cache.delete(markerUrl);
      const entries = bootEntries(value);
      for (let offset = 0; offset < entries.length; offset += 4) {
        const results = await Promise.allSettled(entries.slice(offset, offset + 4).map(async entry => {
          const incoming = await fetchBounded(origin + entry.url, { cache: "no-store", credentials: "same-origin", redirect: "error" });
          await cache.put(origin + entry.url, await verified(incoming, entry));
        }));
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      }
      await cache.put(inventoryUrl, new Response(bytes, { headers: { "content-type": "application/json" } }));
      require(await epoch() === startEpoch, "Offline installation was forgotten");
      await cache.put(markerUrl, new Response(JSON.stringify({ variant: config.variant, buildId: config.buildId,
        inventorySha256: config.inventorySha256, epoch: startEpoch, completedAt: Date.now() })));
      require(await epoch() === startEpoch, "Offline installation was forgotten");
    } catch (error) { await caches.delete(name); throw error; }
    // Activate after boot dependencies pass verification. Optional downloads
    // happen after activation and never hold this install event open. Open
    // documents keep their code and drafts; the next navigation gets this build.
    // Do not reload windows or claim previously uncontrolled clients.
    // Keep the request in the install lifetime. This promise confirms the
    // request, not completed activation; clients observe worker state separately.
    await self.skipWaiting();
    })());
  });

  self.addEventListener("activate", event => event.waitUntil((async () => {
    const current = await ready();
    require(current && current.marker.inventorySha256 === config.inventorySha256, "Offline cache incomplete");
    const previous = [];
    const control = await caches.open(controlName);
    const priorActive = await (await control.match(activeUrl))?.text();
    for (const key of await caches.keys()) {
      if (!key.startsWith(prefix) || key === name) continue;
      const state = await ready(key).catch(() => null);
      if (state) previous.push({ key, completedAt: state.marker.completedAt });
      else await caches.delete(key);
    }
    previous.sort((a, b) => a.key === priorActive ? -1 : b.key === priorActive ? 1 : b.completedAt - a.completedAt);
    for (const item of previous.slice(1)) await caches.delete(item.key);
    await control.put(activeUrl, new Response(name));
    // Retain current and previous startup caches. Full offline coverage is
    // checked separately; retaining a build is not a data backup.
  })()));

  function navigation(pathname) {
    if (pathname === "/") return true;
    if (pathname.includes("%") || pathname.includes("//") || pathname.includes("\\")) return false;
    const match = /^\/(aubos|freedos|lastresort)(?:\/(.*))?$/.exec(pathname);
    if (!match || (config.variant === "portable" && match[1] !== "lastresort")) return false;
    const route = match[2] ?? "";
    if (/^(?:|bridge|council|finance|tools|admin|recommendations|goals|tasks|ideas|opportunities)\/?$/.test(route)) return true;
    if (/^forge(?:\/(?:overview|goals|tasks|ideas))?\/?$/.test(route)) return true;
    if (/^admin\/(?:organization|settings|integrations(?:\/omi)?|exports|activity|decisions)$/.test(route)) return true;
    if (match[1] === "freedos" && route === "factory") return true;
    if (match[1] === "aubos" && (/^goals\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route) ||
        /^tasks\/(?:priority|blocked|all)$/.test(route) ||
        /^opportunities\/(?:selected|reversal-test|consulting-bridge|buyers|pipeline)$/.test(route))) return true;
    // Syntactic private dashboard modules only. Client registration validates
    // exact deeper routes and saved profile admission before showing records.
    return match[1] === "aubos" && /^(?:bridge|finance|tools|admin)\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,3}$/.test(route);
  }

  self.addEventListener("fetch", event => {
    const request = event.request, url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== origin || url.pathname.startsWith("/api/")) return;
    const document = request.mode === "navigate" && navigation(url.pathname);
    // Reload may propagate to subresources in WebKit. Versioned assets still
    // need their verified cache when offline; document freshness is separate.
    if (!document && request.cache === "no-store") return;
    if (url.search && !document) return;
    const assets = config.variant === "private" ? "/assets/" : "/demo-assets/";
    const candidate = document || url.pathname.startsWith(assets) || url.pathname.startsWith("/app-icons/") || url.pathname === "/manifest.webmanifest";
    if (!candidate) return;
    if (document) {
      // Refresh in the background, never ahead of a verified cached document.
      event.waitUntil((async () => {
        try {
          const metadata = await fetchBounded(inventoryUrl, { method: "HEAD", cache: "no-store", credentials: "same-origin", redirect: "error" });
          variantMatches = metadata.status === 200 && metadata.headers.get("x-vorton-variant") === config.variant;
          if (variantMatches && metadata.headers.get("x-vorton-build-id") !== config.buildId && Date.now() - lastVersionCheck > 10000) {
            lastVersionCheck = Date.now();
            // Cancel background extras before requesting replacement. Do not
            // await update() inside the retiring worker's fetch event.
            fillController?.abort();
            void self.registration?.update().catch(() => {});
          }
        } catch { /* Offline paint does not depend on this background check. */ }
      })());
    }
    event.respondWith((async () => {
      // Reload is an explicit freshness request. Ordinary navigation still
      // paints the verified cache first, but reload must not wait for a whole
      // offline bundle to install before showing current server HTML.
      if (document && (url.searchParams.has("__vorton_reload") || ["reload", "no-cache", "no-store"].includes(request.cache))) {
        try {
          const response = await fetchBounded(request, { cache: "no-store" });
          if (response.status < 500) {
            if (response.status !== 200) return response;
            const headers = new Headers(response.headers);
            const bytes = await boundedBytes(response, 8 * 1024 * 1024);
            headers.delete("content-encoding"); headers.delete("content-length");
            return new Response(bytes, { status: response.status, headers });
          }
        } catch { /* Disconnection or a stalled server can use saved code. */ }
      }
      try {
        if (!variantMatches) return fetch(request);
        const state = await ready();
        if (!state || state.marker.inventorySha256 !== config.inventorySha256) return fetch(request);
        const cachedInventory = await state.cache.match(inventoryUrl);
        const { value } = await inventory(cachedInventory);
        const path = document ? "/offline-shell.html" : url.pathname;
        const entry = value.entries.find(item => item.url === path);
        if (!entry) return (!document && await retainedAsset(url.pathname)) || fetch(request);
        let response = await state.cache.match(origin + path);
        if (!response) {
          const incoming = await fetchBounded(request, { cache: "no-store" });
          const checked = await verified(incoming, entry);
          try { await state.cache.put(origin + path, checked.clone()); }
          catch { downloadError = "This file could not be saved offline. Check device storage."; }
          return checked;
        }
        // Integrity checks also run on cache reads, including after worker termination.
        const verifiedResponse = await verified(response, entry);
        return variantMatches ? verifiedResponse : fetch(request);
      } catch { return fetch(request); }
    })());
  });

  self.addEventListener("message", event => {
    const message = event.data, port = event.ports?.[0];
    if (!port || !event.source?.id || message?.contract !== contract || message.variant !== config.variant ||
        typeof message.requestId !== "string" || !message.requestId.length || message.requestId.length > 128 ||
        typeof message.installationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.installationId) ||
        !["STATUS", "ACTIVATE", "PREPARE_OFFLINE", "FORGET_DEVICE"].includes(message.type)) return;
    event.waitUntil((async () => {
      const source = await self.clients.get(event.source.id);
      if (!source || new URL(source.url).origin !== origin) return;
      const sourcePath = new URL(source.url).pathname;
      if (!navigation(sourcePath) && !(config.variant === "private" && sourcePath === "/aubos/update-forge")) return;
      const reply = { contract, requestId: message.requestId, variant: config.variant, buildId: config.buildId, shellId: config.shellId, version: config.version };
      if (message.type === "ACTIVATE") {
        const state = await ready();
        require(state && state.marker.inventorySha256 === config.inventorySha256, "Offline cache incomplete");
        // Acknowledge the verified request without holding this event open.
        // The client observes active-worker status before reporting readiness.
        void self.skipWaiting();
        port.postMessage({ ...reply, type: "ACTIVATED" });
      } else if (message.type === "STATUS") {
        const state = await ready().catch(() => null);
        const available = state?.marker.inventorySha256 === config.inventorySha256;
        port.postMessage({ ...reply, type: "STATUS", ...await coverage(available ? state : null),
          supportsPreparation: Boolean(available), downloading: Boolean(filling), error: downloadError });
      } else if (message.type === "PREPARE_OFFLINE") {
        const state = await ready();
        require(state && state.marker.inventorySha256 === config.inventorySha256, "Offline boot cache incomplete");
        port.postMessage({ ...reply, type: "PREPARING" });
        event.waitUntil(prepareOffline(state));
      } else {
        fillController?.abort();
        // This acknowledges a code-cache deletion, not installation authority.
        const control = await caches.open(controlName);
        await control.put(epochUrl, new Response(crypto.randomUUID()));
        await control.delete(activeUrl);
        for (const key of await caches.keys()) if (key.startsWith(prefix)) await caches.delete(key);
        port.postMessage({ ...reply, type: "FORGOTTEN", installationId: message.installationId });
      }
    })().catch(() => port.postMessage({ contract, requestId: message.requestId, type: "ERROR", variant: config.variant })));
  });
}

export function renderWorker({ variant, buildId, inventorySha256, shellId, version }) {
  if (!["private", "portable"].includes(variant) || !/^[a-f0-9]{64}$/.test(buildId) || !/^[a-f0-9]{64}$/.test(inventorySha256))
    throw new Error("Invalid offline worker configuration");
  if (shellId !== undefined && !/^[a-f0-9]{64}$/.test(shellId)) throw new Error("Invalid shell identity");
  if (version !== undefined && (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version))) throw new Error("Invalid application version");
  return `"use strict";\n(${worker.toString()})(${JSON.stringify({ variant, buildId, inventorySha256, shellId, version })}, ${validatePwaInventory.toString()});\n`;
}
