"use client";
import "./workspace.css";
import type { Profile } from "./types";
import { RoundtableBriefing } from "./council-views";
import { LoadingIndicator } from "./loading-indicator";
import { profileCache } from "./application/profile-cache";
import { useProfileState } from "./application/use-profile-state";

export function CouncilBriefing({ profile }: { profile: Profile }) {
  const { state, error, loading } = useProfileState(profile);
  const refresh = () => { void profileCache.load(profile, true).catch(() => {}); };
  return <div className="vorton-workspace council-briefing">
    {!state ? error ? <section className="panel" role="alert"><h2>Council briefing unavailable</h2><p>{error}</p><button type="button" onClick={refresh}>Retry briefing</button></section> : <LoadingIndicator compact label="Loading council briefing" detail={`Reading ${profile}'s latest saved session`}/>
      : <>{error && <p role="alert">{error} <button onClick={refresh}>Retry briefing</button></p>}{!state.councilSessions?.length ? <section className="panel" aria-label="Council briefing"><h2>Your council briefing</h2><p>No council sessions have been published for {profile} yet.</p><p><a href={`/${profile.toLowerCase()}/council`}>Open Council</a></p><button type="button" disabled={loading} onClick={refresh}>Refresh briefing</button></section> : <RoundtableBriefing state={state}/>}</>}
  </div>;
}
