import { mkdir, lstat, open, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "./errors.ts";

export async function safeDirectory(directory: string): Promise<void> {
  // Callers validate ancestors from their configured root downwards.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink(), "State directory must not be a symlink", 503);
}

export async function atomicJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
