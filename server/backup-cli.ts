import { createDailyBackup, restoreBackup, type BackupSource } from "./backup.ts";
import { check } from "./errors.ts";

export function parseBackupArguments(argv: string[]) {
  const parsed: { root?: string; directory?: string; restore?: string; into?: string; profiles: string[]; resources: string[] } = { profiles: [], resources: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    check(["--root", "--directory", "--restore", "--into", "--profile", "--resource"].includes(flag), "Unknown backup option");
    const value = argv[++index];
    check(value && !value.startsWith("--"), `Supply a value for ${flag}`);
    if (flag === "--profile") parsed.profiles.push(value);
    else if (flag === "--resource") parsed.resources.push(value);
    else {
      const key = flag.slice(2) as "root" | "directory" | "restore" | "into";
      check(parsed[key] === undefined, `Repeated backup option ${flag}`);
      parsed[key] = value;
    }
  }
  check(!parsed.into || parsed.restore, "An isolated restore requires --restore and --into");
  check(!parsed.restore || parsed.into, "An isolated restore requires --restore and --into");
  check(!parsed.restore || !parsed.root && !parsed.directory && !parsed.profiles.length && !parsed.resources.length, "Capture options cannot be combined with a restore");
  return parsed;
}

export async function runBackupCommand(argv: string[], options: { source: () => Promise<BackupSource>; directory: string }) {
  const parsed = parseBackupArguments(argv);
  if (parsed.restore && parsed.into) {
    const manifest = await restoreBackup(parsed.restore, parsed.into);
    return { restored: true, files: manifest.files.length, databases: manifest.files.filter(file => file.kind === "sqlite").length,
      isolated: true, activated: false, historyAdoptionRequired: true };
  }
  const archive = await createDailyBackup(await options.source(), parsed.directory ?? options.directory);
  return { archive, verified: true };
}
