import path from "node:path";
import { check } from "./errors.ts";
import { omiWorkflow } from "./omi-workflow.ts";

type Scope = { root: string; profiles: readonly string[]; roots?: Record<string, string> };
type Options = Record<string, string | undefined>;
function argumentsFor(argv: string[], portable: boolean) {
  const [command, ...args] = argv, options: Options = {};
  const allowed = ["--profile", "--day", "--mode", "--page", "--digest", ...(portable ? ["--root"] : [])];
  for (let i = 0; i < args.length; i += 2) {
    check(allowed.includes(args[i]) && args[i + 1] && !Object.hasOwn(options, args[i]), "Invalid Omi command arguments");
    options[args[i]] = args[i + 1];
  }
  return { command, options };
}
async function execute(scope: Scope, profile: string, command: string | undefined, options: Options) {
  const workflow = omiWorkflow(scope.root, scope.profiles, { roots: scope.roots }), omi = workflow.service(profile);
  if (command === "status") return omi.status(profile);
  if (command === "index") return { ready: await omi.index(profile), batchLimit: 250 };
  if (command === "sync") return omi.sync(profile, { day: options["--day"], mode: options["--mode"] ?? "recent" });
  if (command === "council-manifest") return workflow.manifest(profile, options["--day"]!);
  if (command === "council-read") {
    check(/^\d+$/.test(options["--page"] ?? "") && /^[a-f0-9]{64}$/.test(options["--digest"] ?? ""), "An exact page and evidence digest are required");
    return workflow.page(profile, options["--day"]!, Number(options["--page"]), options["--digest"]!);
  }
  throw Error("Invalid Omi command");
}

/** The portable launcher admits only an explicit root and workspace. Credential
 * entry stays in Admin; no registry, login flow or model call is imported. */
export async function runPortableOmiCli(argv = process.argv.slice(2)): Promise<void> {
  try {
    const { command, options } = argumentsFor(argv, true);
    const root = options["--root"], profile = options["--profile"];
    check(typeof root === "string" && path.isAbsolute(root), "An explicit absolute storage root is required");
    check(typeof profile === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(profile), "An explicit workspace is required");
    // council-read deliberately emits private transcripts, never scheduler logs.
    console.log(JSON.stringify(await execute({ root, profiles: [profile] }, profile, command, options)));
  } catch {
    console.error(JSON.stringify({ error: "omi_operation_failed", nextAction: "Check the explicit storage root, workspace Omi Admin status and command scope." }));
    process.exitCode = 1;
  }
}

/** Installation admission is supplied by its existing private launcher. */
export async function runInstalledOmiCli(scope: Scope, argv = process.argv.slice(2)): Promise<void> {
  try {
    const { command, options } = argumentsFor(argv, false), profile = options["--profile"];
    check(typeof profile === "string" && scope.profiles.includes(profile), "An explicit configured workspace is required");
    console.log(JSON.stringify(await execute(scope, profile, command, options)));
  } catch {
    console.error(JSON.stringify({ error: "omi_operation_failed", nextAction: "Check the workspace's Omi Admin status and exact command scope." }));
    process.exitCode = 1;
  }
}
