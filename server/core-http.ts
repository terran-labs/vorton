import type { Command } from "./store.ts";
import type { ServerResponse } from "node:http";
import type { OmiHttpIntegration } from "./integration-http.mjs";
export type CoreServerOptions = { root: string; port?: number; dist?: string; origin?: string; enabledProfiles?: string[]; defaultPath?: string; sessionToken?: string; installationIdentity?: () => Promise<string>; omi?: OmiHttpIntegration; workspace?: { host: WorkspaceHttpHost; target: string } };
import http from "node:http";
import { Readable } from "node:stream";
import { canonicalWorkspacePath } from "./workspace-routes.ts";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Store, check, Fault } from "./store.ts";
import { requireBrowserHistory } from "./command-admission.ts";
import { installedVersion } from "./version.ts";
import { pipeAssetResponse } from "./asset-delivery.mjs";
import { integrationHandler } from "./integration-http.mjs";
import { sendJson, sendJsonBytes } from "./json-delivery.mjs";
import { WorkspaceHttpHost, releaseWorkspaceResponse } from "./workspace-http-host.ts";
import type { WorkspaceOperation } from "./workspace-http-runtime.ts";
import { installationIdentity as identityForRoot } from "./installation-identity.ts";
import { servePwaAsset } from "./pwa-assets.mjs";
import { parseSyncRequest } from "../shared/sync-contract.ts";
import { DailyBackups, workspaceBackupSource } from "./backup-service.ts";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
};

/** Legacy close callbacks may exit the process, so worker cleanup precedes them. */
export function attachWorkspaceLifecycle(server: http.Server, host: Pick<WorkspaceHttpHost, "close">, backups: Pick<DailyBackups, "stop">, owned: boolean) {
  const originalClose = server.close.bind(server);
  let cleanup: Promise<void> | undefined;
  const drain = () => cleanup ??= Promise.all([owned ? host.close() : Promise.resolve(), backups.stop()]).then(() => {});
  server.close = callback => {
    const done = drain();
    // Attach a rejection observer immediately, even while sockets are draining.
    void done.catch(() => {});
    originalClose(error => {
      void done.then(() => callback?.(error), failure => {
        if (callback) callback(failure);
        else server.emit("error", failure);
      });
    });
    return server;
  };
  server.on("error", () => { if (!server.listening) void drain().catch(() => {}); });
  // Keep resource draining internal. The public promise must close the HTTP
  // listener too, including callers that do not use the legacy callback API.
  return () => new Promise<void>((resolve, reject) => {
    server.close(error => {
      // The callback can carry a cleanup error with the same code as Node's
      // listener error. Only normalize it after independently verifying drain.
      void drain().then(() => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      }, reject);
    });
  });
}

export async function deliverWorkspaceResponse(response: ServerResponse, host: WorkspaceHttpHost, target: string, operation: WorkspaceOperation) {
  const controller = new AbortController();
  const abort = () => { if (!response.writableFinished) controller.abort(); };
  response.once("close", abort);
  response.req.once("aborted", abort);
  if (response.destroyed || response.req.aborted) controller.abort();
  try {
    const result = await host.execute(target, operation, { signal: controller.signal });
    releaseWorkspaceResponse(response, result);
    try {
      for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
      await sendJsonBytes(response.req, response, result.status, result.bytes);
    } finally { result.release(); }
  } finally {
    response.removeListener("close", abort);
    response.req.removeListener("aborted", abort);
  }
}

/** Portable local host. Only explicitly configured profiles are reachable. */
export function createCoreServer({
  root,
  port = 47840,
  dist = path.join(root, "dist"),
  origin = "",
  enabledProfiles = ["LastResort"],
  defaultPath = "/lastresort/bridge",
  sessionToken,
  installationIdentity,
  omi,
  workspace,
}: CoreServerOptions) {
  check(
    Array.isArray(enabledProfiles) &&
      enabledProfiles.length > 0 &&
      enabledProfiles.every(
        (p) => typeof p === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p),
      ),
    "Invalid enabled profiles",
  );
  const registry = new Map(enabledProfiles.map((p) => [p.toLowerCase(), p]));
  check(registry.size === enabledProfiles.length, "Duplicate profile route");
  check(
    typeof defaultPath === "string" &&
      defaultPath.startsWith("/") &&
      !defaultPath.startsWith("//") &&
      registry.has(defaultPath.split("/")[1]),
    "Invalid default route",
  );
  const store = new Store(root, enabledProfiles);
  const runtime = workspace?.host ?? new WorkspaceHttpHost({ targets: [{ id: "core", kind: "portable", root, profiles: enabledProfiles }] });
  const workerTarget = workspace?.target ?? "core";
  runtime.bindPolicy(workerTarget, store);
  const backups = new DailyBackups({ source: () => workspaceBackupSource(root, enabledProfiles, { protectedFiles: omi?.vault?.keyFile ? [omi.vault.keyFile] : [] }), directory: path.join(root, "backups") });
  check(installationIdentity === undefined || typeof installationIdentity === "function", "Invalid installation identity loader");
  const identity = installationIdentity ?? identityForRoot(store.root);
  check(
    sessionToken === undefined || /^[a-f0-9]{64}$/.test(sessionToken),
    "Invalid host session token",
  );
  const token = sessionToken ?? randomBytes(32).toString("hex");
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  if (origin) {
    const parsed = new URL(origin);
    check(
      parsed.origin === origin && ["https:", "http:"].includes(parsed.protocol),
      "Exact origin required",
    );
    allowed.add(origin);
  }
  const hosts = new Set([...allowed].map((v) => new URL(v).host));
  const integrations = integrationHandler({ root, profiles: enabledProfiles, token, allowed, omi });
  const json = (res: ServerResponse, status: number, value: unknown) => sendJson(res.req, res, status, value);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    try {
      check(hosts.has(req.headers.host!), "Host is not configured", 403);
      if (req.headers.origin)
        check(allowed.has(req.headers.origin!), "Origin is not configured", 403);
      check(
        req.headers["sec-fetch-site"] !== "cross-site",
        "Cross-site request denied",
        403,
      );
      const installationId = await identity();
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (await servePwaAsset(req, res, url.pathname, { dist, variant: "portable", installationId })) return;
      if (await integrations(req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/api/health")
        return json(res, 200, { service: "vorton-local", status: "ready" });
      if (req.method === "GET" && url.pathname === "/api/version")
        return json(res, 200, installedVersion);
      if (req.method === "GET" && url.pathname === "/api/session")
        return json(res, 200, { token, profiles: enabledProfiles, installationId, variant: "portable" });
      const match =
        /^\/api\/([a-z0-9_-]+)\/(state|command|review|export|changes|sync)$/.exec(
          url.pathname,
        );
      if (match) {
        const profile = registry.get(match[1]);
        const operation = match[2];
        check(profile, "Unknown installation", 404);
        if (operation === "state" && url.searchParams.has("view"))
          check(["full", "workspace", "replica"].includes(url.searchParams.get("view")!), "Unknown state view", 400);
        if (req.method === "GET" && operation === "changes")
          return await deliverWorkspaceResponse(res, runtime, workerTarget, { kind: "changes", profile, after: Number(url.searchParams.get("after") ?? 0),
            head: url.searchParams.has("head") ? Number(url.searchParams.get("head")) : undefined,
            generation: url.searchParams.get("generation") ?? undefined,
          });
        if (
          req.method === "GET" &&
          ["state", "export", "review"].includes(operation)
        ) {
          if (operation === "review")
            return await deliverWorkspaceResponse(res, runtime, workerTarget, { kind: "review", profile,
              session: url.searchParams.get("session") === "1", role: url.searchParams.get("role") ?? undefined });
          if (operation === "export")
            return await deliverWorkspaceResponse(res, runtime, workerTarget, { kind: "export", profile, councilSession: url.searchParams.get("councilSession") });
          return await deliverWorkspaceResponse(res, runtime, workerTarget, { kind: "state", profile,
            view: (url.searchParams.get("view") ?? undefined) as "full" | "workspace" | "replica" | undefined,
            councilSession: url.searchParams.get("councilSession") });
        }
        check(
          req.method === "POST" && ["command", "sync"].includes(operation),
          "Method not allowed",
          405,
        );
        check(
          allowed.has(req.headers.origin!),
          "A same-origin request is required",
          403,
        );
        const supplied = Buffer.from((req.headers["x-vorton-session"] ?? "") as string);
        const expected = Buffer.from(token);
        check(
          supplied.length === expected.length &&
            timingSafeEqual(supplied, expected),
          "Session expired. Reload this page.",
          403,
        );
        check(
          req.headers["content-type"]?.split(";")[0] === "application/json",
          "Expected JSON",
          415,
        );
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          check(size <= 131072, "Request is too large", 413);
          chunks.push(chunk);
        }
        let command: unknown;
        try {
          command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new Fault(400, "Invalid JSON");
        }
        check(
          command && typeof command === "object" && !Array.isArray(command),
          "Expected a command",
        );
        if (operation === "sync") {
          let request;
          try { request = parseSyncRequest(command); }
          catch (error) { throw new Fault(400, error instanceof Error ? error.message : String(error)); }
          return await deliverWorkspaceResponse(res, runtime, workerTarget, { kind: "sync", profile, request });
        }
        requireBrowserHistory(command);
        return await deliverWorkspaceResponse(res, runtime, workerTarget, { kind: "command", profile, command: command as Command });
      }
      check(!url.pathname.startsWith("/api/"), "Unknown route", 404);
      check(["GET", "HEAD"].includes(req.method!), "Method not allowed", 405);
      const canonical = canonicalWorkspacePath(
        url.pathname,
        defaultPath,
        enabledProfiles,
      );
      if (canonical !== url.pathname) {
        res.writeHead(308, { Location: canonical + url.search });
        return res.end();
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      const relative = decodeURIComponent(url.pathname.slice(1));
      const asset = relative.startsWith("demo-assets/");
      check(
        asset || registry.has(relative.split("/")[0]),
        "Unknown route",
        404,
      );
      check(
        !relative.includes("..") &&
          !relative.includes("\\") &&
          !relative.includes("\0"),
        "Invalid asset path",
        404,
      );
      let target;
      let data;
      try {
        const base = await realpath(dist);
        target = await realpath(
          path.join(base, asset ? relative : "index.html"),
        );
        check(target.startsWith(base + path.sep), "Invalid asset path", 404);
        data = await readFile(target);
      } catch (error) {
        if (error instanceof Fault) throw error;
        throw new Fault(404, "Application asset not found. Run npm run build.");
      }
      // Local files use the same encoding and confidentiality policy as the
      // proxied application. HEAD keeps metadata without sending a body.
      const incoming: Readable & { statusCode?: number } = Readable.from(req.method === "HEAD" ? [] : [data]);
      incoming.statusCode = 200;
      pipeAssetResponse(req, res, incoming, {
        "content-type":
          mime[path.extname(target)] ?? "application/octet-stream",
        "content-length": data.length,
      }, url.pathname, null);
    } catch (error) {
      if (!res.headersSent)
        json(res, error instanceof Fault ? error.status : 500, {
          ...(error instanceof Fault && error.code ? { code: error.code } : {}),
          error:
            error instanceof Fault
              ? error.message
              : "Operation failed. Local records were not reset.",
        });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  const close = attachWorkspaceLifecycle(server, runtime, backups, !workspace);
  return { server, store, hosts, allowed, backups, ready: () => runtime.ready(), close };
}
