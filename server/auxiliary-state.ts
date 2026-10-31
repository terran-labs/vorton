import { lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { check, errorCode } from "./errors.ts";

type Workspace = { revision: number; syncGeneration?: string; auxiliary?: Record<string, unknown> };
type Command = { requestId: string; expectedRevision: number; expectedGeneration?: string; action: string; payload: { key: string } };
type CommandStore = {
  read(scope: string): Promise<Workspace>;
  readAuxiliary?(scope: string, key: string): Promise<Workspace>;
  transact(scope: string, command: Command, reduce: (state: Workspace) => Promise<{ id: string; actor: string; detail: string }>): Promise<unknown>;
  transactAuxiliary?(scope: string, command: Command, key: string, reduce: (state: Workspace) => Promise<{ id: string; actor: string; detail: string }>): Promise<unknown>;
};
type Options<T> = {
  store: () => Promise<CommandStore>; scope: string; key: string;
  initial: () => T; validate: (input: unknown) => T; legacyFile: string;
};

/** Trusted installation services share the workspace command transaction.
 * HTTP input cannot supply a reducer. Existing JSON is an import dependency,
 * never a writable fallback or something to silently replace with empty data. */
export class AuxiliaryState<T> {
  private readonly options: Options<T>;
  constructor(options: Options<T>) {
    check(/^[a-z][a-zA-Z0-9]{0,63}$/.test(options.key), "Invalid auxiliary state key");
    this.options = options;
  }
  private async value(workspace: Workspace): Promise<T> {
    const value = workspace.auxiliary?.[this.options.key];
    if (value !== undefined) return this.options.validate(structuredClone(value));
    try {
      await lstat(this.options.legacyFile);
      check(false, "Private application state has not been imported. Complete its verified SQLite import before continuing.", 503);
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    return this.options.validate(this.options.initial());
  }
  private readWorkspace(store: CommandStore) { return store.readAuxiliary ? store.readAuxiliary(this.options.scope, this.options.key) : store.read(this.options.scope); }
  async read(): Promise<T> {
    const store = await this.options.store();
    return this.value(await this.readWorkspace(store));
  }
  async readWithHistory(): Promise<{ value: T; syncGeneration: string }> {
    const workspace = await this.readWorkspace(await this.options.store());
    check(typeof workspace.syncGeneration === "string" && workspace.syncGeneration.length > 0, "Server history is unavailable", 503);
    return { value: await this.value(workspace), syncGeneration: workspace.syncGeneration };
  }
  async change<R>(reduce: (value: T) => R | Promise<R>, history?: { expectedGeneration: unknown }): Promise<R> {
    if (history) check(typeof history.expectedGeneration === "string" && history.expectedGeneration.length > 0,
      "Reload the current app before saving. Your local work remains on this device.", 409, "history-required");
    const store = await this.options.store();
    const baseline = await this.readWorkspace(store);
    // Check retained-source admission even when a caller's reducer is a no-op.
    await this.value(baseline);
    let result!: R;
    const transact = (command: Command, reduce: (state: Workspace) => Promise<{ id: string; actor: string; detail: string }>) => store.transactAuxiliary
      ? store.transactAuxiliary(this.options.scope, command, this.options.key, reduce)
      : store.transact(this.options.scope, command, reduce);
    await transact({
      requestId: randomUUID(), expectedRevision: baseline.revision,
      // Browser authority stays bound to the reviewed read. Trusted services
      // capture their baseline before reduction and retain the same SQL fence.
      expectedGeneration: history ? history.expectedGeneration as string : baseline.syncGeneration,
      action: `private.${this.options.key}`, payload: { key: this.options.key },
    }, async workspace => {
      const value = await this.value(workspace);
      result = await reduce(value);
      const validated = this.options.validate(value);
      workspace.auxiliary ??= {};
      workspace.auxiliary[this.options.key] = structuredClone(validated);
      return { id: this.options.key, actor: "application", detail: "Private application state updated" };
    });
    return result;
  }
}
