import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { pipeline } from "node:stream";

const immutableAsset = /^\/(?:local\/)?(?:assets|demo-assets)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2)$/;
// Match only the host's content-addressed browser JSON paths. Mutable manifests
// and planning APIs retain no-store; the final assertion rejects trailing text.
const immutableDashboardAsset = /^\/dashboard-views\/[a-f0-9]{64}\/(?:[a-z][a-z0-9-]*|parts\/[A-Za-z][A-Za-z0-9_-]*)\.[a-f0-9]{64}\.json$(?![\s\S])/;

export function assetCacheControl(pathname: string, method: string | undefined, status: number, development: boolean | null | undefined, headers: OutgoingHttpHeaders = {}) {
  if (!development && ["GET", "HEAD"].includes(method ?? "") && [200, 304].includes(status) &&
      !headers["set-cookie"] && /^\/maps\/world-(?:local|countries)\.json$/.test(pathname)) {
    return "private, no-cache";
  }
  // Never infer immutability from an arbitrary extension or upstream policy.
  return !development && ["GET", "HEAD"].includes(method ?? "") &&
    [200, 304].includes(status) && !headers["set-cookie"] &&
    (immutableAsset.test(pathname) || immutableDashboardAsset.test(pathname))
    ? "private, max-age=31536000, immutable"
    : "no-store";
}

export function preferredEncoding(value: string | string[] = ""): "br" | "gzip" | null {
  const qualities = new Map<string, number>();
  for (const item of String(value).toLowerCase().split(",")) {
    const [name, ...parameters] = item.trim().split(";");
    const q = parameters.find((p) => p.trim().startsWith("q="));
    const weight = q ? Number(q.trim().slice(2)) : 1;
    qualities.set(name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  const weight = (name: string) => qualities.get(name) ?? qualities.get("*") ?? 0;
  return (["br", "gzip"] as const).filter((name) => weight(name) > 0)
    .sort((a, b) => weight(b) - weight(a))[0] ?? null;
}

export function pipeAssetResponse(request: IncomingMessage, response: ServerResponse, incoming: Readable & { statusCode?: number }, headers: OutgoingHttpHeaders & { etag?: string }, pathname: string, development: boolean | null | undefined) {
  const status = incoming.statusCode || 502;
  headers["cache-control"] = assetCacheControl(pathname, request.method, status, development, headers);
  const compressible = /^(?:text\/|application\/(?:javascript|json|xml)|image\/svg\+xml)/i.test(String(headers["content-type"] || ""));
  const eligible = !development && request.method === "GET" && status === 200 &&
    !headers["content-encoding"] && !headers["content-range"] && compressible &&
    (headers["content-length"] === undefined || Number(headers["content-length"]) >= 1024);
  if (eligible) {
    const vary = String(headers.vary || "").split(",").map((v) => v.trim()).filter(Boolean);
    if (!vary.some((v) => ["*", "accept-encoding"].includes(v.toLowerCase()))) vary.push("Accept-Encoding");
    headers.vary = vary.join(", ");
  }
  const encoding = eligible && preferredEncoding(request.headers["accept-encoding"]);
  if (encoding) {
    headers["content-encoding"] = encoding;
    delete headers["content-length"];
    // A transformed representation cannot retain a strong identity validator.
    if (headers.etag && !headers.etag.startsWith("W/")) headers.etag = `W/${headers.etag}`;
  }
  response.writeHead(status, headers);
  const streams = encoding
    ? [incoming, encoding === "br" ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : createGzip(), response]
    : [incoming, response];
  pipeline(streams, (error) => { if (error) response.destroy(error); });
}
