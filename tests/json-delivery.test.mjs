import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { sendJson, sendJsonBytes } from "../server/json-delivery.mjs";

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (method = "GET", encoding = "identity") => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, method,
      headers: { "accept-encoding": encoding } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}

test("encoded JSON preserves byte offsets, HTTP metadata and HEAD semantics", async t => {
  const json = Buffer.from(JSON.stringify({ title: "Café", value: 7 }));
  const framed = Buffer.concat([Buffer.from("private-prefix"), json, Buffer.from("private-suffix")]);
  const bytes = new Uint8Array(framed.buffer, framed.byteOffset + 14, json.length);
  const deliveries = [];
  const request = await fixture(t, (req, res) => {
    res.setHeader("Vary", "Origin");
    deliveries.push(sendJsonBytes(req, res, 201, bytes));
  });
  const get = await request();
  assert.equal(get.status, 201); assert.deepEqual(get.body, json);
  assert.equal(get.headers["cache-control"], "no-store");
  assert.equal(get.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(get.headers.vary, "Origin, Accept-Encoding");
  assert.equal(get.headers["content-length"], String(json.length));
  const head = await request("HEAD");
  assert.equal(head.body.length, 0); assert.equal(head.headers["content-length"], String(json.length));
  await Promise.all(deliveries);
});

test("worker bytes use the existing streaming gzip policy", async t => {
  const bytes = Buffer.from(JSON.stringify({ title: "Compressible content ".repeat(5000) }));
  const deliveries = [];
  const request = await fixture(t, (req, res) => { deliveries.push(sendJsonBytes(req, res, 200, bytes)); });
  const result = await request("GET", "gzip");
  assert.equal(result.headers["content-encoding"], "gzip");
  assert.equal(result.headers["content-length"], undefined);
  assert.deepEqual(gunzipSync(result.body), bytes);
  await Promise.all(deliveries);
});

test("delivery remains pending under backpressure and rejects when its destination closes", async () => {
  const response = new PassThrough({ highWaterMark: 1 });
  const headers = new Map();
  response.getHeader = name => headers.get(name);
  response.setHeader = (name, value) => headers.set(name, value);
  response.removeHeader = name => headers.delete(name);
  response.writeHead = status => { response.statusCode = status; };
  let settled = false;
  const delivery = sendJsonBytes({ method: "GET", headers: {} }, response, 200, Buffer.alloc(4096));
  const outcome = delivery.then(() => { settled = true; }, error => { settled = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "a response permit cannot be released while bytes are blocked");
  const failure = new Error("Synthetic client disconnect");
  response.destroy(failure);
  assert.equal(await outcome, failure);
});

test("legacy object delivery remains compatible", async t => {
  const value = { status: "ready", count: 3 };
  const request = await fixture(t, (req, res) => {
    assert.equal(sendJson(req, res, 200, value), undefined);
  });
  assert.deepEqual(JSON.parse((await request()).body), value);
});
