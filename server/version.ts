import { readFileSync } from "node:fs";

// Capture at startup so editing a checkout cannot relabel the running process.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof manifest.version !== "string") throw Error("The application package version is missing");
export const installedVersion = Object.freeze({ version: manifest.version });
