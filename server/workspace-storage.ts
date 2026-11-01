import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { check, errorCode } from "./errors.ts";
import { validateDescriptors } from './workspace-normalization.ts';

/** Read-only admission check shared by installation adapters and recovery. */
export async function hasWorkspaceSnapshot(filename: string, scope: string, contract?: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, "SQLite state must be a private regular file.", 503);
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      database.exec('BEGIN');
      const versions = database.prepare("SELECT version FROM replica_schema").all();
      check(versions.length === 1 && [1,2].includes(Number(versions[0]!.version)), 'Unsupported workspace storage format', 503);
      if (Number(versions[0]!.version) === 2) {
        validateDescriptors(database,scope);
        if (!database.prepare('SELECT 1 FROM workspace_roots WHERE scope=?').get(scope)) return false;
        if (contract === undefined) return true;
        const field = database.prepare("SELECT value_json FROM workspace_fields WHERE scope=? AND name='storage' AND storage_kind='value'").get(scope);
        return field ? (JSON.parse(String(field.value_json)) as { contract?: string }).contract === contract : false;
      }
      const row = database.prepare("SELECT body FROM workspace_snapshots WHERE scope=?").get(scope);
      if (!row) return false;
      if (contract === undefined) return true;
      const snapshot = JSON.parse(String(row.body)) as { storage?: { contract?: string } };
      return snapshot.storage?.contract === contract;
    } finally { database.close(); }
  } catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
}
