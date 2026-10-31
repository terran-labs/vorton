import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { ApplicationHeader } from "../design/application-header";
import { WorkspaceNavigation, type WorkspaceLink } from "../design/workspace-navigation";
import { BackgroundAtmosphere } from "../design/background-atmosphere";
import { LoadingIndicator } from "../loading-indicator";
import { loadSession, profileCache, profileReplica } from "./profile-cache";
import { useWorkspaceAccess, workspaceAccess } from "./offline-context";
import { captureAdmissionTicket, captureOfflineScope, readSavedAdmission, saveVerifiedAdmission, subscribeOfflineStore, type OfflineVariant, type SavedAdmission } from "./offline-store.ts";
import { startPwa, codeRecovery, recoveryEntry, pwaStatus } from "./pwa-client";
import { navigate, ordinaryClick, useBrowserLocation } from "./browser-router";
import { rememberedForgePath } from "./forge-preference";
import { OfflineControls } from "./offline-controls";
import { ConnectionStatus } from "./connection-status";
import { useToolbarHeadingPolicy } from "../design/toolbar-heading-policy";
import { retryGate, retryScope, RetryFailure, retryReason } from "./retry-gate.ts";

export type ApplicationRoute = {
  profile: string; page: string; title: string; redirect?: string;
  forgeView?: string; adminSection?: string; secondaryNavigation?: boolean; planningState?: boolean; [key: string]: unknown;
};
export type ApplicationRegistration = {
  variant: OfflineVariant;
  profiles: string[]; defaultProfile: string;
  resolve: (pathname: string) => ApplicationRoute | null;
  links: (profile: string) => WorkspaceLink[];
  Screen: ComponentType<{ route: ApplicationRoute }>;
  prefetch?: (route: ApplicationRoute) => void;
  brand?: (profile: string) => ReactNode;
  actions?: (route: ApplicationRoute) => ReactNode;
  overlay?: (profile: string) => ReactNode;
};

export function Application({ registration }: { registration: ApplicationRegistration }) {
  useEffect(() => profileReplica.start(), []);
  const href = useBrowserLocation();
  const [recoveryPending, setRecoveryPending] = useState(Boolean(codeRecovery));
  useEffect(() => { void codeRecovery?.finally(() => setRecoveryPending(false)); }, []);
  const pwa = useSyncExternalStore(pwaStatus.subscribe, pwaStatus.getSnapshot);
  const currentCodeReady = (pwa.codeReady ?? pwa.ready) && pwa.shellId === document.querySelector('meta[name="vorton-shell"]')?.getAttribute("content");
  const [entryPending, setEntryPending] = useState(recoveryEntry);
  useEffect(() => { if (!entryPending) return; const timer = setTimeout(() => setEntryPending(false), 2000); return () => clearTimeout(timer); }, [entryPending]);
  useToolbarHeadingPolicy(href);
  const pathname = href.split(/[?#]/, 1)[0];
  const focusFragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("__vorton_recovery")) return;
    url.searchParams.delete("__vorton_recovery");
    navigate(url.href, { replace: true });
  }, [href]);
  const access = useWorkspaceAccess();
  const [attempt, setAttempt] = useState(0);
  const explicitAttempt = useRef(false);
  const requestReconnect = (explicit = false) => { explicitAttempt.current = explicit; setAttempt(value => value + 1); };
  const [installPermission, setInstallPermission] = useState<string>();
  const savedRoute = useRef<SavedAdmission | undefined>(undefined);
  const [routeReadComplete, setRouteReadComplete] = useState(false);
  const route = registration.resolve(pathname);
  const redirect = route ? rememberedForgePath(pathname, route.profile) ?? route.redirect : undefined;
  const readable = access.onlineAdmission || Boolean(access.scope);
  const admitted = Boolean(readable && route && access.variant === registration.variant && access.installationId && access.admittedProfiles.includes(route.profile) && registration.profiles.includes(route.profile));
  const profile = admitted ? route!.profile : "Vorton";
  useEffect(() => {
    let active = true, generation = 0, pending = false, observedOnline = false, explicitRecoveryAdmission = false, ordinaryAdmission = false;
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined, suspended = false;
    const key = () => retryScope(workspaceAccess.getSnapshot(), route?.profile ?? registration.defaultProfile);
    const cancel = () => { suspended = true; generation++; pending = false; controller?.abort(); clearTimeout(timer); timer = undefined; profileCache.suspend(); };
    const schedule = () => {
      clearTimeout(timer); timer = undefined;
      if (!active || suspended || document.visibilityState === "hidden" || typeof navigator !== "undefined" && navigator.onLine === false) return;
      const state = retryGate.inspect(key());
      if (!state.paused && state.remaining > 0) timer = setTimeout(() => void reconcile(), state.remaining);
    };
    if (!workspaceAccess.getSnapshot().managed || workspaceAccess.getSnapshot().variant !== registration.variant) {
      workspaceAccess.manage(registration.variant);
      setInstallPermission(undefined);
    }
    if (!workspaceAccess.getSnapshot().installationId) void readSavedAdmission(registration.variant).then(saved => {
      if (!active) return;
      if (saved.ok && saved.value) savedRoute.current = saved.value.admission;
      setRouteReadComplete(true);
      if (observedOnline || !saved.ok || !saved.value) return;
      workspaceAccess.restore({ ...saved.value.admission, profiles: saved.value.admission.profiles.filter(id => registration.profiles.includes(id)) }, saved.value.scope);
    });
    else setRouteReadComplete(true);
    const reconcile = async (explicit = false) => {
      if (!active || suspended || pending || document.visibilityState === "hidden" || typeof navigator !== "undefined" && navigator.onLine === false) return;
      const recoveryProfile = route?.profile ?? registration.defaultProfile;
      if (!explicit && profileReplica.requiresExplicitAdmission(recoveryProfile)) return;
      if (explicit && profileReplica.requiresReadOnlyRecovery(recoveryProfile)) {
        ordinaryAdmission = false; pending = true; controller = new AbortController(); const request = ++generation;
        try { await profileReplica.verifyAdmission(recoveryProfile, controller.signal); }
        catch { /* Recovery errors stay in the scoped replica status. Never publish ordinary admission here. */ }
        finally { if (active && request === generation) pending = false; }
        return;
      }
      const scopeKey = key();
      let ticket: ReturnType<typeof retryGate.begin>;
      try { ticket = retryGate.begin(scopeKey, explicit, explicit); } catch { schedule(); return; }
      explicitRecoveryAdmission = explicit && profileReplica.requiresExplicitAdmission(recoveryProfile);
      ordinaryAdmission = true;
      if (!workspaceAccess.beginReconcile(explicit)) { retryGate.finish(ticket, false); return; }
      pending = true;
      controller = new AbortController();
      const owner = controller;
      const request = ++generation;
      try {
        const admissionTicket = await captureAdmissionTicket(registration.variant);
        if (!active || request !== generation) return;
        const session = await loadSession(true, { signal: owner.signal, key: scopeKey, explicit, admission: true, attempt: ticket });
        if (!active || request !== generation) return;
        retryGate.revalidate(ticket);
        observedOnline = true;
        if (session.variant !== registration.variant) {
          retryGate.fail(scopeKey, new RetryFailure("Installation variant changed", "validation"));
          workspaceAccess.fail("This installation serves a different application. Reopen it online.", true);
          return;
        }
        const admission: SavedAdmission = { schema: 1, installationId: session.installationId, variant: session.variant, profiles: session.profiles.filter(id => registration.profiles.includes(id)), verifiedAt: Date.now() };
        // Hide a replaced installation immediately, before awaiting local storage.
        workspaceAccess.admitOnline(admission, undefined, false);
        const scope = await captureOfflineScope(admission);
        if (!active || request !== generation) return;
        if (scope.ok && admissionTicket.ok) {
          const saved = await saveVerifiedAdmission(scope.value, admission, admissionTicket.value);
          if (!active || request !== generation) return;
          if (!saved.ok && saved.reason === "obsolete") {
            // Another tab accepted a newer session. Reconcile again rather than
            // enable writes from this superseded response.
            requestReconnect();
            return;
          }
        }
        workspaceAccess.admitOnline(admission, scope.ok ? scope.value : undefined);
        if (scopeKey === retryScope(workspaceAccess.getSnapshot(), route?.profile ?? registration.defaultProfile)) retryGate.recover(scopeKey, "auth");
        if (explicit && profileReplica.requiresExplicitAdmission(recoveryProfile)) profileReplica.completeExplicitAdmission(recoveryProfile);
        if (scopeKey.includes("/unadmitted/")) retryGate.finish(ticket, true);
        setInstallPermission(`${session.variant}:${session.installationId}`);
      } catch (reason) {
        if (active && request === generation) {
          retryGate.fail(scopeKey, reason);
          if (scopeKey.includes("/unadmitted/") && workspaceAccess.getSnapshot().installationId) retryGate.inherit(scopeKey, key());
          const message = reason instanceof Error ? reason.message : "Connection unavailable";
          const rejected = retryReason(reason) === "auth" || /Invalid workspace session/.test(message);
          if (rejected) observedOnline = true;
          workspaceAccess.fail(message, rejected);
        }
      } finally { retryGate.finish(ticket, false); if (active && request === generation) { pending = false; ordinaryAdmission = false; explicitRecoveryAdmission = false; schedule(); } }
    };
    const foreground = () => { if (document.visibilityState === "hidden") cancel(); else { suspended = false; void reconcile(); } };
    const offline = () => { cancel(); if (!["cleared", "forgotten"].includes(workspaceAccess.getSnapshot().status)) workspaceAccess.fail("Offline. Saved records are read-only."); };
    const unsubscribe = subscribeOfflineStore(change => {
      const before = workspaceAccess.getSnapshot();
      workspaceAccess.storageChanged(change);
      if (before !== workspaceAccess.getSnapshot()) { cancel(); observedOnline = true; profileCache.clear(); if (change.type === "FORGOTTEN") setInstallPermission(undefined); }
    });
    const unsubscribeRetry = retryGate.subscribe(() => {
      if (pending && ordinaryAdmission && profileReplica.requiresReadOnlyRecovery(route?.profile ?? registration.defaultProfile)) {
        generation++; pending = false; ordinaryAdmission = false; controller?.abort();
      }
      schedule();
    });
    let readEpoch = workspaceAccess.getSnapshot().epoch;
    const unsubscribeAccess = workspaceAccess.subscribe(() => {
      if (readEpoch !== workspaceAccess.getSnapshot().epoch) {
        readEpoch = workspaceAccess.getSnapshot().epoch; profileCache.suspend();
        const currentProfile = route?.profile ?? registration.defaultProfile;
        if (profileReplica.requiresExplicitAdmission(currentProfile) && (!explicitRecoveryAdmission || profileReplica.requiresReadOnlyRecovery(currentProfile))) {
          generation++; pending = false; controller?.abort();
        }
      }
    });
    const explicit = explicitAttempt.current;
    explicitAttempt.current = false;
    void reconcile(explicit);
    window.addEventListener("pageshow", foreground);
    window.addEventListener("online", foreground);
    window.addEventListener("offline", offline);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", foreground);
    return () => { active = false; cancel(); unsubscribe(); unsubscribeRetry(); unsubscribeAccess(); window.removeEventListener("pageshow", foreground); window.removeEventListener("online", foreground); window.removeEventListener("offline", offline); window.removeEventListener("pagehide", cancel); document.removeEventListener("visibilitychange", foreground); };
  }, [registration, attempt, route?.profile]);
  const identity = access.installationId && access.status !== "forgotten" ? `${access.variant}:${access.installationId}` : undefined;
  useEffect(() => {
    if (!identity || !access.installationId) return;
    return startPwa({ installationId: access.installationId, variant: access.variant }, { allowInstall: installPermission === identity });
  }, [identity, installPermission]);
  useEffect(() => {
    if (!access.installationId) return;
    if (pathname === "/") {
      if (!routeReadComplete) return;
      const saved = savedRoute.current;
      const matching = saved?.installationId === access.installationId && saved?.variant === access.variant;
      const remembered = matching && saved?.lastRoute && registration.resolve(saved.lastRoute.split(/[?#]/, 1)[0]);
      if (remembered && access.admittedProfiles.includes(remembered.profile)) { navigate(saved!.lastRoute!, { replace: true }); return; }
      const first = access.admittedProfiles.includes(registration.defaultProfile) ? registration.defaultProfile : access.admittedProfiles.find(id => registration.profiles.includes(id));
      if (first) navigate(`/${first.toLowerCase()}/bridge`, { replace: true });
    } else if (admitted && redirect) {
      const destination = new URL(redirect, location.origin);
      destination.search = location.search;
      if (!destination.hash) destination.hash = location.hash;
      navigate(destination.href, { replace: true });
    }
  }, [pathname, access.installationId, access.variant, access.admittedProfiles, admitted, redirect, registration, routeReadComplete]);
  useEffect(() => { document.title = admitted ? route!.title : "Vorton · Page not found"; }, [admitted, route?.title]);
  useEffect(() => {
    if (!admitted || redirect || !route) return;
    workspaceAccess.setProfile(route.profile);
    const ticket = workspaceAccess.getSnapshot();
    registration.prefetch?.(route);
    if (route.planningState !== false) {
      void profileCache.hydrate(route.profile);
      void profileCache.load(route.profile, ticket.onlineAdmission && ticket.status === "reconciling").then(() => {
        if (profileCache.canConfirmLive(route.profile, ticket)) workspaceAccess.confirmLive(ticket);
      }).catch(() => {});
    }
    if (ticket.onlineAdmission && ticket.scope && ticket.verifiedAt) void saveVerifiedAdmission(ticket.scope, { schema: 1, installationId: ticket.scope.installationId, variant: ticket.variant, profiles: [...ticket.admittedProfiles], verifiedAt: ticket.verifiedAt, lastRoute: href });
  }, [href, admitted, redirect, registration, route?.profile, route?.planningState, access.onlineAdmission, access.installationId, access.verifiedAt, access.scope]);
  useEffect(() => {
    const target = (event: Event) => {
      if (!readable) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self") || anchor.rel.split(/\s+/).includes("external")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) return;
      const next = registration.resolve(url.pathname);
      if (!next || !access.admittedProfiles.includes(next.profile) || !registration.profiles.includes(next.profile)) return;
      return { anchor, url, route: next };
    };
    const follow = (event: MouseEvent) => {
      if (!ordinaryClick(event)) return;
      const next = target(event);
      if (!next) return;
      if (next.url.pathname === location.pathname && next.url.search === location.search && next.url.hash) return;
      event.preventDefault();
      const menu = next.anchor.closest("details");
      if (menu) menu.open = false;
      navigate(next.url.href);
    };
    const prefetch = (event: Event) => {
      const next = target(event);
      if (!next) return;
      registration.prefetch?.(next.route);
      if (next.route.planningState !== false) void profileCache.load(next.route.profile).catch(() => {});
    };
    document.addEventListener("click", follow);
    document.addEventListener("pointerover", prefetch);
    document.addEventListener("focusin", prefetch);
    document.addEventListener("touchstart", prefetch, { passive: true });
    return () => {
      document.removeEventListener("click", follow);
      document.removeEventListener("pointerover", prefetch);
      document.removeEventListener("focusin", prefetch);
      document.removeEventListener("touchstart", prefetch);
    };
  }, [registration, access.admittedProfiles, readable]);
  useEffect(() => {
    if (!admitted || redirect) return;
    const frame = requestAnimationFrame(() => {
      // A destination can finish admission after its fields are already usable.
      // Do not steal focus if the user started editing before this frame ran.
      const active = document.activeElement;
      if (active?.matches("input, textarea, select, [contenteditable=true]") && document.getElementById("workspace-main")?.contains(active)) return;
      const fragment = focusFragment;
      const target = document.getElementById(fragment || "workspace-main");
      if (fragment) target?.scrollIntoView({ block: "start" });
      else { target?.focus({ preventScroll: true }); window.scrollTo(0, 0); }
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, focusFragment, admitted, redirect]);
  const Screen = registration.Screen;
  return <><BackgroundAtmosphere/><div className={`aubos-content-layer dashboard-shell${admitted && route?.secondaryNavigation ? "" : " single-level-navigation"}`}>
    <a className="skip-link" href="#workspace-main">Skip to content</a>
    <ApplicationHeader profile={profile} labels={{ LastResort: "The Last Resort" }} brandSymbol={registration.brand?.(profile)} actions={<>{admitted ? registration.actions?.(route!) : undefined}<OfflineControls onReconnect={() => requestReconnect(true)}/></>}>
      <WorkspaceNavigation profile={profile} page={route?.page === "factory" ? "tools" : route?.page ?? ""} links={admitted ? registration.links(profile) : []}/>
    </ApplicationHeader>
    <main className={`view-frame${route?.page === "council" ? " council-frame" : ""}`} id="workspace-main" tabIndex={-1}>
      {recoveryPending || entryPending && !currentCodeReady && !pwa.error ? <LoadingIndicator label="Opening workspace"/> : !access.installationId ? access.message ? <section role="alert"><h1>Workspace session unavailable</h1><p>{access.message}</p><button onClick={() => requestReconnect(true)}>Retry</button></section> : <LoadingIndicator label="Opening workspace"/>
        : admitted ? redirect ? <LoadingIndicator label={`Opening ${route!.page}`}/> : <Suspense fallback={<LoadingIndicator label={`Opening ${route!.page}`}/>}><Screen key={identity} route={route!}/></Suspense>
        : <section><h1>Page not found</h1><p>This workspace or route is unavailable.</p>{access.admittedProfiles.filter(id => registration.profiles.includes(id)).map(id => <p key={id}><a href={`/${id.toLowerCase()}/bridge`}>Open {id === "LastResort" ? "The Last Resort" : id}</a></p>)}</section>}
    </main>
    {admitted && <div key={`${access.variant}:${access.installationId}:${profile}`}>{registration.overlay?.(profile)}</div>}
  </div><ConnectionStatus href={href} onReconnect={requestReconnect}/></>;
}
