import { useSyncExternalStore } from "react";
import { profileReplica } from "./profile-cache";

export function useReplica(profile: string) {
  return useSyncExternalStore(listener => profileReplica.subscribe(profile, listener), () => profileReplica.getSnapshot(profile));
}
