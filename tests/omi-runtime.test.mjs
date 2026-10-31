import test from "node:test";
import assert from "node:assert/strict";
import * as vault from "../server/integration-vault.mjs";
import * as typedVault from "../server/integration-vault.ts";
import * as client from "../server/omi-client.mjs";
import * as typedClient from "../server/omi-client.ts";
import * as integration from "../server/omi-integration.mjs";
import * as typedIntegration from "../server/omi-integration.ts";
import * as http from "../server/integration-http.mjs";
import * as typedHttp from "../server/integration-http.ts";

test("Omi compatibility entrypoints expose the exact native TypeScript runtime", () => {
  for (const [bridge, implementation] of [[vault, typedVault], [client, typedClient], [integration, typedIntegration], [http, typedHttp]]) {
    assert.deepEqual(Object.keys(bridge), Object.keys(implementation));
    for (const key of Object.keys(implementation)) assert.equal(bridge[key], implementation[key]);
  }
});
