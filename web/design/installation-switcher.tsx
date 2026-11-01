"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InstalledVersion } from "../installed-version";
import { VortonSymbol } from "./icons";
import { Tooltip } from "./Tooltip";
import styles from "./installation-switcher.module.css";
import { loadSession } from "../application/profile-cache";
import { useWorkspaceAccess } from "../application/offline-context";

export function InstallationSwitcher({profile, labels = {}, actions, brandSymbol}: {profile: string; labels?: Record<string,string>; actions?: ReactNode; brandSymbol?: ReactNode}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const labelId = useId();
  const label = labels[profile] ?? profile;
  brandSymbol ??= profile === "Vorton" ? <VortonSymbol/> : undefined;
  const access = useWorkspaceAccess();
  const [legacyProfiles, setProfiles] = useState([profile]);
  const profiles = access.managed ? access.admittedProfiles : legacyProfiles;
  useEffect(() => {
    let active = true;
    if (!access.managed) loadSession().then(session => { if (active) setProfiles(session.profiles); }).catch(() => {});
    const closeOutside = (event: Event) => {
      if (menu.current && event.target instanceof Node && !menu.current.contains(event.target)) menu.current.open = false;
    };
    document.addEventListener('pointerdown',closeOutside,true);
    document.addEventListener('focusin',closeOutside);
    return () => {active=false;document.removeEventListener('pointerdown',closeOutside,true);document.removeEventListener('focusin',closeOutside);};
  }, [profile, access.managed]);
  return <details ref={menu} className="installation-switcher brand-block" onKeyDown={event => {
    if (event.key === 'Escape' && menu.current) {menu.current.open=false;menu.current.querySelector('summary')?.focus();}
  }}>
    <Tooltip asChild label={label}>
    <summary className={`brand-mark ${styles.trigger}`} data-brand={profile} aria-label="Switch installation" aria-describedby={labelId}>{brandSymbol ? <span className={styles.brandSymbol} aria-hidden="true">{brandSymbol}</span> : <span className={styles.initial} aria-hidden="true">{Array.from(label.trim())[0]}</span>}<span className={styles.label} id={labelId}>{label}</span><svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg></summary>
    </Tooltip>
    <nav className={`installation-links ${styles.menu}`} aria-label="Vorton installations">
      {profiles.map(id => <a key={id} className="installation-option" href={`/${id.toLowerCase()}/bridge`} aria-current={profile===id?'true':undefined}>
        <svg className="installation-check" aria-hidden="true" viewBox="0 0 24 24" width="24" height="24">{profile===id && <path d="m5 12 4 4L19 6"/>}</svg><span>{labels[id] ?? id}</span>
      </a>)}
      {actions && <section className="installation-page-controls" aria-label="Page controls">{actions}</section>}
      <InstalledVersion/>
    </nav>
  </details>;
}
