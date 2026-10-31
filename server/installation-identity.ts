import path from "node:path";
import { constants } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { check, Fault, errorCode } from "./errors.ts";
import { safeDirectory } from "./private-files.ts";

const limit = 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function readIdentity(filename: string): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    check(info.isFile() && info.size > 0 && info.size <= limit && (info.mode & 0o077) === 0,
      "Invalid installation identity metadata", 503);
    // Bound the read even if another process grows the file after stat.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    check(length <= limit, "Invalid installation identity metadata", 503);
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    check(value && Object.keys(value).sort().join(",") === "installationId,schema" &&
      value.schema === 1 && typeof value.installationId === "string" && uuid.test(value.installationId),
      "Invalid installation identity metadata", 503);
    return value.installationId;
  } finally { await file.close(); }
}

/** Stable, nonsecret identity for the actual Store root, independent of sessions. */
export async function loadInstallationIdentity(root: string): Promise<string> {
  try {
    const resolved = path.resolve(root);
    // Check every ancestor before creating runtime metadata through it.
    let directory = path.parse(resolved).root;
    for (const component of resolved.slice(directory.length).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, component);
      await safeDirectory(directory);
    }
    const runtime = path.join(resolved, ".runtime");
    await safeDirectory(runtime);
    const filename = path.join(runtime, "installation.json");
    try { return await readIdentity(filename); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }

    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ schema: 1, installationId: randomUUID() }) + "\n");
        await file.sync();
      } finally { await file.close(); }
      // Publish complete bytes without overwriting a concurrent startup's winner.
      try { await link(temporary, filename); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      const parent = await open(runtime, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(error => { if (errorCode(error) !== "ENOENT") throw error; }); }
    return await readIdentity(filename);
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(503, "Installation identity is unavailable. Restore verified metadata; do not reset it.");
  }
}

/** Initialize only after HTTP admission; share this loader with composed hosts. */
export function installationIdentity(root: string): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => pending ??= loadInstallationIdentity(root);
}
