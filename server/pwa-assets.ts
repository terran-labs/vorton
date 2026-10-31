import type { IncomingMessage, ServerResponse } from "node:http";
import type { BinaryLike } from "node:crypto";
export type PwaInventory = { schema: 1 | 2; variant: "private" | "portable"; buildId: string; entries: { url: string; size: number; sha256: string; contentType: string; role?: "boot" | "offline" | "optional" }[] };
type PwaOptions = { dist: string; variant: "private" | "portable"; installationId: string; development?: boolean; shellCsp?: string };
import path from "node:path";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { check, Fault, errorCode } from "./errors.ts";
import { pipeAssetResponse } from "./asset-delivery.ts";

const routes = new Set(["/sw.js", "/offline-assets.json", "/offline-shell.html", "/manifest.webmanifest"]);
export const pwaHash = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");

/** Also embedded in the worker. Keep this validator independent of Node APIs. */
export function validatePwaInventory(input: unknown, variant: string): PwaInventory {
  const value = input as PwaInventory;
  const hex = /^[a-f0-9]{64}$/;
  const types: Record<string, string> = {
    js: "text/javascript", css: "text/css", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2",
    ttf: "font/ttf", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon",
    jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
  };
  if (!["private", "portable"].includes(variant) || !value ||
      Object.keys(value).sort().join(",") !== "buildId,entries,schema,variant" || ![1, 2].includes(value.schema) || value.variant !== variant ||
      typeof value.buildId !== "string" || !hex.test(value.buildId) ||
      !Array.isArray(value.entries) || value.entries.length < 2 || value.entries.length > 512)
    throw new Error("Invalid offline inventory");
  let previous = "", total = 0;
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).sort().join(",") !== (value.schema === 2 ? "contentType,role,sha256,size,url" : "contentType,sha256,size,url") ||
        (value.schema === 2 && !["boot", "offline", "optional"].includes(entry.role ?? "")) || typeof entry.url !== "string" || entry.url <= previous ||
        entry.url.includes("..") || !hex.test(entry.sha256) || typeof entry.sha256 !== "string" ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 8 * 1024 * 1024 ||
        typeof entry.contentType !== "string") throw new Error("Invalid offline entry");
    const url = entry.url;
    const assets = variant === "private" ? "assets" : "demo-assets";
    const code = new RegExp("^/" + assets + "/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.(js|css|wasm|woff2?|ttf|png|svg|ico|jpe?g|webp|gif|avif)$").exec(url);
    const icon = variant === "private"
      ? /^\/app-icons\/graphite-v[56]\/(?:aubos|freedos|vorton)\/(?:favicon\.(svg|ico)|icon-(?:32|180|192|512)\.(png)|safari-pinned-tab\.(svg))$/.exec(url)
      : null;
    const expected = url === "/offline-shell.html" ? "text/html"
      : url === "/manifest.webmanifest" ? "application/manifest+json"
      : code ? types[code[1]] : icon ? types[icon.slice(1).find(Boolean) ?? ""] : null;
    if (!expected || entry.contentType.split(";")[0].trim() !== expected) throw new Error("Disallowed offline asset");
    previous = url; total += entry.size;
  }
  if (total > 32 * 1024 * 1024 || !value.entries.some(e => e.url === "/offline-shell.html") ||
      !value.entries.some(e => e.url === "/manifest.webmanifest")) throw new Error("Incomplete offline inventory");
  if (value.schema === 2 && !value.entries.some(e => e.url === "/offline-shell.html" && e.role === "boot"))
    throw new Error("Offline boot shell is missing");
  return value;
}

async function readBuildFile(dist: string, relative: string, maximum: number) {
  const base = path.resolve(dist);
  const directory = await lstat(base);
  check(directory.isDirectory() && !directory.isSymbolicLink(), "Invalid PWA build root", 404);
  let current = base;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    check(!(await lstat(current)).isSymbolicLink(), "Invalid PWA asset path", 404);
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= maximum, "Invalid PWA asset size", 503);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    check(length === stat.size, "PWA asset changed during read", 503);
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Mount after Host/Origin admission. Never resolves arbitrary filesystem URLs. */
export async function servePwaAsset(request: IncomingMessage, response: ServerResponse, pathname: string, { dist, variant, installationId, development, shellCsp }: PwaOptions) {
  if (!routes.has(pathname)) return false;
  check((request.url ?? "").split("?")[0] === pathname, "Invalid PWA asset path", 404);
  check(["GET", "HEAD"].includes(request.method ?? ""), "Method not allowed", 405);
  check(!development, "Offline application unavailable in development", 404);
  try {
    const inventoryBytes = await readBuildFile(dist, "offline-assets.json", 512 * 1024);
    const inventory = validatePwaInventory(JSON.parse(inventoryBytes.toString("utf8")), variant);
    check(inventory.buildId === pwaHash(JSON.stringify({ schema: inventory.schema, variant, entries: inventory.entries })),
      "Offline build identity mismatch", 503);
    let bytes = inventoryBytes, contentType = "application/json; charset=utf-8";
    if (pathname === "/sw.js") {
      bytes = await readBuildFile(dist, "sw.js", 1024 * 1024);
      contentType = "text/javascript; charset=utf-8";
      response.setHeader("Service-Worker-Allowed", "/");
    } else if (pathname !== "/offline-assets.json") {
      const entry = inventory.entries.find(e => e.url === pathname);
      check(entry, "Offline asset entry is missing", 503);
      bytes = await readBuildFile(dist, pathname === "/offline-shell.html" ? "index.html" : "manifest.webmanifest", 8 * 1024 * 1024);
      check(bytes.length === entry.size && pwaHash(bytes) === entry.sha256, "Offline asset integrity mismatch", 503);
      contentType = entry.contentType;
      if (pathname === "/offline-shell.html" && shellCsp) response.setHeader("Content-Security-Policy", shellCsp);
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Vorton-Installation-Id", installationId);
    response.setHeader("X-Vorton-Variant", variant);
    response.setHeader("X-Vorton-Build-Id", inventory.buildId);
    response.setHeader("X-Vorton-Inventory-Sha256", pwaHash(inventoryBytes));
    const incoming = Object.assign(Readable.from(request.method === "HEAD" ? [] : [bytes]), { statusCode: 200 });
    pipeAssetResponse(request, response, incoming, { "content-type": contentType, "content-length": bytes.length }, pathname, null);
    return true;
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(errorCode(error) === "ENOENT" ? 404 : 503, "Offline application build is unavailable or invalid.");
  }
}
