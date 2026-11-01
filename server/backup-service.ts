import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { BackupSource } from "./backup.ts";
import { Worker } from "node:worker_threads";
import { installedVersion } from "./version.ts";
import { check, errorCode } from "./errors.ts";
import type { Server } from "node:http";

export type BackupStatus = {
  phase: "idle" | "running" | "ready" | "failed";
  lastSuccessAt: string | null; lastFailureAt: string | null;
  archive: string | null; error: string | null;
};
type BackupServiceOptions = { source: () => Promise<BackupSource>; directory: string; clock?: () => Date };

function captureInWorker(source: BackupSource, directory: string, now: Date): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./backup-worker.ts", import.meta.url), {
      workerData: { source, directory, date: now.toISOString(), applicationVersion: installedVersion.version }, execArgv: [],
    });
    let archive: string | undefined, failure: Error | undefined;
    worker.on("message", (result: unknown) => {
      if (result && typeof result === "object" && "archive" in result && typeof result.archive === "string") archive = result.archive;
      else failure = new Error("Automatic backup did not return a verified archive.");
    });
    worker.once("error", error => { failure = error; });
    // Settle only after exit, so a retry or stop cannot leave another capture
    // thread running. Never terminate a successful publication mid-flight.
    worker.once("exit", code => {
      if (failure || code !== 0 || !archive) reject(failure ?? new Error("Automatic backup stopped before confirming a verified archive."));
      else resolve(archive);
    });
  });
}

/** The installation adapter adds its managed evidence and private resources.
 * Keys stay outside the vault snapshot's security boundary. */
export async function workspaceBackupSource(root: string, profiles: readonly string[], extra: {
  databases?: string[]; resources?: string[]; excludes?: string[]; protectedFiles?: string[]; recovery?: Record<string, unknown>;
} = {}): Promise<BackupSource> {
  check(profiles.length > 0 && profiles.every(profile => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile)), "Invalid backup workspace set");
  const present = async (relative: string): Promise<boolean> => {
    try { await lstat(path.join(root, relative)); return true; }
    catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
  };
  const databases = [...(extra.databases ?? [])], resources = [...(extra.resources ?? [])];
  for (const profile of profiles) {
    const database = `${profile}/state/core.sqlite3`;
    check(await present(database), "A required workspace database is unavailable. Finish storage initialization or recover the missing store before backup.");
    databases.push(database);
    for (const resource of [`${profile}/state/core.json`, `${profile}/organization`, `${profile}/files`])
      if (await present(resource)) resources.push(resource);
  }
  if (await present(".runtime/integrations/vault.sqlite")) databases.push(".runtime/integrations/vault.sqlite");
  for (const resource of ["local.config.json", ".runtime/installation.json"])
    if (await present(resource)) resources.push(resource);
  const protectedResources: string[] = [];
  const physicalRoot = await realpath(root);
  for (const filename of [...(extra.protectedFiles ?? []), ...(process.env.VORTON_INTEGRATION_KEY_FILE ? [process.env.VORTON_INTEGRATION_KEY_FILE] : [])]) {
    let physicalFile = path.resolve(filename);
    try { physicalFile = await realpath(physicalFile); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) throw error; }
    const relative = path.relative(physicalRoot, physicalFile);
    if (relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) protectedResources.push(relative.split(path.sep).join("/"));
  }
  return { root, databases: [...new Set(databases)], resources: [...new Set(resources)], protectedResources,
    excludes: extra.excludes,
    recovery: { ...extra.recovery, profiles: [...profiles], integrationKeys: "Recover integration vault keys separately; they are not in this archive." } };
}

/** While the application runs, check on startup and hourly. Dated archives
 * provide durable once-per-day behavior across reopen and concurrent processes.
 * Nothing promises execution while the application is stopped. */
export class DailyBackups {
  private pending?: Promise<BackupStatus>;
  private timer?: ReturnType<typeof setInterval>;
  private verifiedDay?: string;
  private state: BackupStatus = { phase: "idle", lastSuccessAt: null, lastFailureAt: null, archive: null, error: null };
  private readonly options: BackupServiceOptions;
  constructor(options: BackupServiceOptions) { this.options = options; }
  status(): BackupStatus { return { ...this.state }; }
  run(): Promise<BackupStatus> {
    if (this.pending) return this.pending;
    this.state = { ...this.state, phase: "running", error: null };
    this.pending = (async () => {
      try {
        const now = this.options.clock?.() ?? new Date();
        const day = now.toISOString().slice(0, 10);
        if (this.verifiedDay === day && this.state.archive) {
          this.state = { ...this.state, phase: "ready" };
          return this.status();
        }
        const archive = await captureInWorker(await this.options.source(), this.options.directory, now);
        this.verifiedDay = day;
        this.state = { ...this.state, phase: "ready", archive, lastSuccessAt: now.toISOString(), error: null };
      } catch (error) {
        this.state = { ...this.state, phase: "failed", lastFailureAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Automatic backup failed. Check storage and retry." };
      }
      return this.status();
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => { void this.run(); }, 60 * 60 * 1000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}

export function attachDailyBackups(server: Server, backups: DailyBackups): void {
  if (server.listening) backups.start();
  else server.once("listening", () => backups.start());
  server.once("close", () => { void backups.stop(); });
}
