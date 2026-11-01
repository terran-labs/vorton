import path from "node:path";
import { demoRoot } from "./demo-seed.ts";
import { parseBackupArguments, runBackupCommand } from "../server/backup-cli.ts";
import { workspaceBackupSource } from "../server/backup-service.ts";

const argv = process.argv.slice(2), args = parseBackupArguments(argv), root = path.resolve(args.root ?? demoRoot);
const source = () => workspaceBackupSource(root, args.profiles.length ? args.profiles : ["LastResort"], { resources: args.resources });
console.log(JSON.stringify(await runBackupCommand(argv, { source, directory: path.resolve(args.directory ?? path.join(root, "backups")) }), null, 2));
