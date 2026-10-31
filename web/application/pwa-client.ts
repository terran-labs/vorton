import { readJsonWithDeadline } from "./profile-cache";

export const codeRecovery = (globalThis as typeof globalThis & { __vortonCodeRecovery?: Promise<void> }).__vortonCodeRecovery;
export const recoveryEntry = Boolean((globalThis as typeof globalThis & { __vortonRecoveryEntry?: boolean }).__vortonRecoveryEntry);

type Variant = "private" | "portable";
type Identity = { installationId: string; variant: Variant };
export type PwaStatus = {
  supported: boolean; ready: boolean; preparing: boolean;
  codeReady?: boolean; pendingAssets?: number; optionalPending?: number;
  runningVersion?: string; availableVersion?: string;
  updateAvailable: boolean; error?: string; buildId?: string; shellId?: string; needsNavigation?: boolean;
};
const contract = "vorton.offline-control.v1";
const listeners = new Set<() => void>();
let status: PwaStatus = { supported: false, ready: false, preparing: false, updateAvailable: false };
type RunningPwa = { identity: Identity; registration?: ServiceWorkerRegistration; setup?: Promise<ServiceWorkerRegistration | undefined>; retry?: () => Promise<void> };
let current: RunningPwa | undefined;
const publish = (next: PwaStatus) => { status = next; listeners.forEach(listener => listener()); };

async function deadline<T>(operation: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The browser did not finish preparing offline access. You can keep using this page.")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export const pwaStatus = {
  getSnapshot: () => status,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

function message(worker: ServiceWorker, identity: Identity, type: "STATUS" | "ACTIVATE" | "FORGET_DEVICE" | "PREPARE_OFFLINE"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => finish(new Error("Offline storage did not respond. Try again.")), 4000);
    function finish(error?: Error, value?: Record<string, unknown>) {
      clearTimeout(timer); channel.port1.close(); channel.port2.close();
      if (error) reject(error); else resolve(value!);
    }
    channel.port1.onmessage = event => {
      const value = event.data;
      if (!value || value.contract !== contract || value.requestId !== requestId || value.variant !== identity.variant) return;
      if (value.type === "ERROR") finish(new Error(typeof value.error === "string" ? value.error : "Offline storage is unavailable."));
      else if (value.type === (type === "STATUS" ? "STATUS" : type === "ACTIVATE" ? "ACTIVATED" : type === "PREPARE_OFFLINE" ? "PREPARING" : "FORGOTTEN")) {
        if (type === "FORGET_DEVICE" && value.installationId !== identity.installationId) return;
        finish(undefined, value);
      }
    };
    try { worker.postMessage({ contract, type, requestId, ...identity }, [channel.port2]); }
    catch { finish(new Error("Offline storage is unavailable.")); }
  });
}

/** Registration follows admission. Neither updates nor foreground returns reload
 * the page: an existing document keeps its code and unfinished forms.
 */
export function startPwa(identity: Identity, { allowInstall = false }: { allowInstall?: boolean } = {}): () => void {
  const own: RunningPwa = { identity };
  current = own;
  let cancelled = false;
  let lastUpdate = 0;
  let inspection = 0;
  let retryPreparation = false;
  const activationRequested = new WeakSet<ServiceWorker>();
  const documentShell = document.querySelector?.('meta[name="vorton-shell"]')?.getAttribute("content");
  const runningVersion = document.querySelector?.('meta[name="vorton-version"]')?.getAttribute("content") ?? undefined;
  const cleanups: Array<() => void> = [];
  let pending: Promise<void> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let preparationPoll: ReturnType<typeof setTimeout> | undefined;
  const valid = () => !cancelled && current === own;
  const failed = () => {
    if (valid()) publish({ ...status, preparing: false, error: "Offline update did not finish. You can keep using this page; Vorton will retry automatically." });
  };
  const watch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { if (!status.ready || status.preparing) failed(); }, 20000);
  };
  if (!globalThis.isSecureContext || !("serviceWorker" in navigator)) {
    publish({ supported: false, ready: false, preparing: false, updateAvailable: false });
    return () => { cancelled = true; };
  }
  publish({ supported: true, ready: false, preparing: true, updateAvailable: false, runningVersion });
  const activateWaiting = (registration: ServiceWorkerRegistration) => {
    const waiting = registration.waiting;
    if (waiting && !activationRequested.has(waiting)) {
      activationRequested.add(waiting);
      void message(waiting, identity, "ACTIVATE").then(() => { void inspect(); }).catch(() => { activationRequested.delete(waiting); });
    }
  };
  const inspect = async () => {
    const sequence = ++inspection;
    const registration = own.registration;
    if (!valid() || !registration) return;
    // Once replacement is waiting, stop waking the retiring worker with STATUS
    // requests. Chromium can restart that worker while activation is stopping it.
    if (registration.waiting && registration.waiting !== registration.active) {
      activateWaiting(registration);
      publish({ ...status, preparing: !status.error });
      return;
    }
    activateWaiting(registration);
    const worker = registration.active;
    let ready = false, codeReady = false, downloading = false;
    let pendingAssets: number | undefined, optionalPending: number | undefined;
    let workerError: string | undefined, buildId: string | undefined, shellId: string | undefined, availableVersion: string | undefined;
    if (worker) {
      try {
        const value = await message(worker, identity, "STATUS");
        ready = value.ready === true;
        codeReady = typeof value.codeReady === "boolean" ? value.codeReady : ready;
        downloading = value.downloading === true;
        pendingAssets = typeof value.pendingAssets === "number" ? value.pendingAssets : undefined;
        optionalPending = typeof value.optionalPending === "number" ? value.optionalPending : undefined;
        workerError = typeof value.error === "string" ? value.error : undefined;
        buildId = typeof value.buildId === "string" ? value.buildId : undefined;
        shellId = typeof value.shellId === "string" ? value.shellId : undefined;
        availableVersion = typeof value.version === "string" ? value.version : undefined;
        if (allowInstall && value.supportsPreparation === true && (!ready || (optionalPending ?? 0) > 0) && !downloading && (!workerError || retryPreparation)) {
          retryPreparation = false;
          await message(worker, identity, "PREPARE_OFFLINE");
          downloading = true;
          workerError = undefined;
        }
      } catch { /* A first install may not have an active worker yet. */ }
    }
    if (!valid() || sequence !== inspection) return;
    // Read waiting after the asynchronous status response: installation may
    // finish while that request is in flight.
    const waiting = registration.waiting;
    activateWaiting(registration);
    if (waiting && waiting !== registration.active) {
      publish({ ...status, preparing: !status.error });
      return;
    }
    let newerShell = false;
    if (codeReady && shellId && documentShell && shellId !== documentShell) {
      try {
        // Fresh HTML may be ahead of the offline controller after a reload.
        // Only advertise its replacement when the worker matches the server.
        const live = await readJsonWithDeadline("/offline-assets.json", undefined, 4000) as { buildId?: string; variant?: string };
        newerShell = live.buildId === buildId && live.variant === identity.variant;
      } catch { /* Offline code may lag the displayed document. Do not reload. */ }
    }
    if (valid() && sequence === inspection) {
      const preparing = Boolean(registration.installing || waiting || downloading && !ready);
      if (ready && !preparing) clearTimeout(watchdog);
      publish({ supported: true, ready, codeReady, pendingAssets, optionalPending, runningVersion, availableVersion,
        preparing: preparing && !workerError, updateAvailable: newerShell, buildId, shellId,
        error: workerError ?? (ready && !preparing ? undefined : status.error) });
      clearTimeout(preparationPoll);
      if (downloading && document.visibilityState !== "hidden") preparationPoll = setTimeout(() => { void inspect(); }, 1000);
    }
  };
  const foreground = () => {
    if (!valid() || document.visibilityState === "hidden") return;
    void inspect();
    if (allowInstall && Date.now() - lastUpdate > 60_000) {
      lastUpdate = Date.now();
      void own.retry?.();
    }
  };
  const connect = () => (own.setup = (async () => {
    if (codeRecovery) return;
    const existing = await deadline(navigator.serviceWorker.getRegistration("/"));
    const script = existing?.active?.scriptURL ?? existing?.waiting?.scriptURL ?? existing?.installing?.scriptURL;
    if (existing && script === new URL("/sw.js", location.origin).href) {
      if (allowInstall && existing.active && !existing.waiting && !recoveryEntry) {
        // Original clients cannot activate a waiting replacement. Migrate only
        // a positively identified legacy Vorton worker, keeping all stored data.
        const value = await message(existing.active, identity, "STATUS").catch(() => undefined);
        if (!value) return existing;
        if (value.ready === true && typeof value.shellId !== "string") {
          await deadline(existing.unregister());
          clearTimeout(watchdog);
          if (valid()) publish({ supported: true, ready: false, preparing: false, updateAvailable: true, needsNavigation: true });
          // Re-registering from the old controlled document can revive its
          // obsolete registration. The shared edit-safe updater navigates first.
          return;
        } else return existing;
      } else return existing;
    }
    if (!valid() || !allowInstall) return;
    const registration = navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    // Keep a late result available to the explicit forget operation.
    void registration.then(value => { own.registration = value; }, () => {});
    return deadline(registration);
  })().then(registration => {
    // A clear can dispose the UI while register() is pending. Keep its result
    // available so forgetting can fence that installer and unregister it.
    own.registration = registration;
    if (!valid()) return registration;
    if (!registration) {
      if (status.needsNavigation) return;
      publish({ supported: true, ready: false, preparing: false, updateAvailable: false });
      return;
    }
    const installing = () => {
      watch();
      const worker = registration.installing;
      if (worker) {
        const changed = () => { void inspect(); };
        worker.addEventListener("statechange", changed);
        cleanups.push(() => worker.removeEventListener("statechange", changed));
      }
      void inspect();
    };
    registration.addEventListener("updatefound", installing);
    cleanups.push(() => registration.removeEventListener("updatefound", installing));
    installing();
    return registration;
  }).catch(() => {
    failed();
    return undefined;
  }));
  own.retry = () => {
    if (pending || !valid() || !allowInstall || status.needsNavigation) return pending ?? Promise.resolve();
    lastUpdate = Date.now();
    retryPreparation = true;
    publish({ ...status, preparing: true, error: undefined }); watch();
    pending = (async () => {
      const registration = own.registration ?? await connect();
      if (!valid() || !registration) return;
      await deadline(registration.update());
      await inspect();
    })().catch(failed).finally(() => { pending = undefined; });
    return pending;
  };
  watch();
  void connect().then(registration => { if (registration) foreground(); });
  document.addEventListener("visibilitychange", foreground);
  window.addEventListener("pageshow", foreground);
  window.addEventListener("online", foreground);
  const controlled = () => { void inspect(); };
  navigator.serviceWorker.addEventListener?.("controllerchange", controlled);
  const poll = setInterval(foreground, 60_000);
  return () => {
    cancelled = true;
    for (const cleanup of cleanups) cleanup();
    document.removeEventListener("visibilitychange", foreground);
    window.removeEventListener("pageshow", foreground);
    window.removeEventListener("online", foreground);
    navigator.serviceWorker.removeEventListener?.("controllerchange", controlled);
    clearInterval(poll);
    clearTimeout(watchdog);
    clearTimeout(preparationPoll);
  };
}

export async function checkPwaUpdate(): Promise<void> {
  await current?.retry?.();
}

export async function forgetPwaCode(identity: Identity): Promise<void> {
  const own = current;
  if (!own || own.identity.installationId !== identity.installationId || own.identity.variant !== identity.variant) throw new Error("The installation changed. Reopen local storage controls.");
  const registration = own.registration ?? await own.setup;
  if (current !== own) throw new Error("The installation changed while clearing offline code.");
  const worker = registration?.active ?? registration?.waiting ?? registration?.installing;
  if (worker) await message(worker, identity, "FORGET_DEVICE");
  if (current !== own) throw new Error("The installation changed while clearing offline code.");
  await registration?.unregister();
  current = undefined;
  publish({ supported: true, ready: false, preparing: false, updateAvailable: false });
}
