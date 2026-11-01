import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteReplica } from "../server/sqlite-replica.ts";
import { parseWorkspacePreparationArguments, prepareWorkspaceMigration } from "../server/workspace-maintenance.ts";

export async function prepareWorkspace(argv: string[]) {
  const input = parseWorkspacePreparationArguments(argv);
  return prepareWorkspaceMigration(input, filename => new SqliteReplica(filename));
}

if (process.argv[1] && [fileURLToPath(import.meta.url), fileURLToPath(import.meta.url).replace(/\.ts$/, ".mjs")].includes(path.resolve(process.argv[1]))) {
  prepareWorkspace(process.argv.slice(2)).then(receipt => console.log(JSON.stringify(receipt, null, 2))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
