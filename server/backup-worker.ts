import { parentPort, workerData } from "node:worker_threads";
import { createDailyBackup, type BackupSource } from "./backup.ts";

const { source, directory, date, applicationVersion } = workerData as { source: BackupSource; directory: string; date: string; applicationVersion: string };
// SQLite snapshot and integrity operations are synchronous. Keep both capture
// and complete restore verification away from the application's HTTP thread.
const archive = await createDailyBackup(source, directory, new Date(date), applicationVersion);
parentPort!.postMessage({ archive });
