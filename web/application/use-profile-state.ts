import { useEffect, useSyncExternalStore } from "react";
import { profileCache } from "./profile-cache";

export function useProfileState(profile: string) {
  const snapshot = useSyncExternalStore(
    listener => profileCache.subscribe(profile, listener),
    () => profileCache.read(profile),
  );
  useEffect(() => {
    void profileCache.hydrate(profile);
    void profileCache.load(profile).catch(() => {});
  }, [profile]);
  return snapshot;
}
