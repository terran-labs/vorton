import type { IncomingMessage, ServerResponse } from "node:http";
import type { Transform } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import { preferredEncoding } from "./asset-delivery.ts";

/** Streaming compression keeps private JSON off the synchronous zlib path. */
export function sendJson(request: IncomingMessage, response: ServerResponse, status: number, value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  // Existing callers do not await delivery. The pipeline still owns response
  // destruction on failure; worker callers await the byte variant below.
  void sendJsonBytes(request, response, status, data).catch(() => {});
}

/** Deliver worker-encoded bytes without parsing, copying or encoding them again.
 * The caller retains its response permit until this promise settles. */
export function sendJsonBytes(request: IncomingMessage, response: ServerResponse, status: number, bytes: Uint8Array): Promise<void> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vary = String(response.getHeader("Vary") || "").split(",").map(v => v.trim()).filter(Boolean);
  if (!vary.some(v => ["*", "accept-encoding"].includes(v.toLowerCase()))) vary.push("Accept-Encoding");
  const encoding = data.length >= 1024 && preferredEncoding(request.headers["accept-encoding"]);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", vary.join(", "));
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.removeHeader("Content-Length");
  response.removeHeader("Content-Encoding");
  if (encoding) response.setHeader("Content-Encoding", encoding);
  else response.setHeader("Content-Length", data.length);
  response.writeHead(status);
  const streams: (Readable | Transform | ServerResponse)[] = [Readable.from(request.method === "HEAD" ? [] : [data])];
  if (encoding && request.method !== "HEAD") streams.push(encoding === "br"
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
    : createGzip());
  streams.push(response);
  return new Promise((resolve, reject) => {
    pipeline(streams, error => {
      if (error) { response.destroy(error); reject(error); }
      else resolve();
    });
  });
}
