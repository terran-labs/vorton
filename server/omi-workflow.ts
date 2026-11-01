export type WorkflowOptions = { roots?: Record<string, string>; services?: Record<string, OmiIntegration>; clock?: () => number };
import { OmiIntegration, councilScanExclusions } from "./omi-integration.ts";
import { check } from "./errors.ts";
import { pacificDay } from "./omi-client.ts";

/** Existing scheduler threads call this facade; it never launches an agent or model. */
export function omiWorkflow(root: string, profiles: readonly string[], { roots = {}, services = {}, clock = () => Date.now() }: WorkflowOptions = {}) {
  const service = (profile: string) => {
    check(profiles.includes(profile), "Unknown installation", 404);
    return services[profile] ??= new OmiIntegration(roots[profile] ?? root, [profile]);
  };
  return {
    service,
    manifest: (profile: string, day: string) => service(profile).councilMaterial(profile, day),
    page: (profile: string, day: string, page: number, digest: string) => service(profile).councilMaterial(profile, day, page, digest),
    acknowledge: (profile: string, receipt: Parameters<OmiIntegration["acknowledgeCouncil"]>[1]) => service(profile).acknowledgeCouncil(profile, receipt),
    failed: (profile: string, at: string) => service(profile).councilFailed(profile, at),
    async refresh(profile: string, day: string) {
      try {
        const omi = service(profile), status = await omi.status(profile);
        if (status.councilEnabled === false || (!status.keyConfigured && !status.historyCount)) return { status: "disabled" };
        if (!status.enabled || !status.keyConfigured) return { status: "deferred", code: "sync_disabled" };
        if (Date.parse(pacificDay(day).end) > clock()) return { status: "deferred", code: "day_in_progress" };
        if (status.retryAt && Date.parse(status.retryAt) > clock()) return { status: "deferred", code: "retry_pending", retryAt: status.retryAt };
        const recent = await omi.sync(profile, { day, mode: "replay", maxPages: 20 });
        check(recent, "Omi synchronization unavailable", 503);
        if (recent.status === "failed") return recent;
        if (recent.code !== "filtered_end_unverified") return { ...recent, status: "deferred" };
        const exclusions = councilScanExclusions(recent);
        if (exclusions.blockingExcluded) return { ...recent, ...exclusions, status: "deferred", code: "daily_records_excluded" };
        const overlap = await omi.sync(profile, { day, mode: "recent", maxPages: 2 });
        check(overlap, "Omi synchronization unavailable", 503);
        if (overlap.status === "failed") return overlap;
        // Historical catch-up stays inside the same run and its request budget.
        const backfill = await omi.sync(profile, { day, mode: "backfill", maxPages: 8 });
        check(backfill, "Omi synchronization unavailable", 503);
        if (backfill.status === "failed") return backfill;
        return { ...recent, ...exclusions, status: "ready" };
      } catch {
        // Storage migration, a competing lease or admission failure must not
        // fall through to stale retained evidence or leak a private error.
        return { status: "deferred", code: "ingestion_unavailable" };
      }
    },
  };
}
