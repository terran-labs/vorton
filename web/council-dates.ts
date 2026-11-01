import type { State } from "./types";
type Session = NonNullable<State["councilSessions"]>[number];
export const councilTimezone = "America/Los_Angeles";
// Shared by every session label; constructing these per call multiplies work
// across the timeline's initial render and geometry updates.
const pacificFormatter = new Intl.DateTimeFormat("en-US", {timeZone:councilTimezone,year:"numeric",month:"2-digit",day:"2-digit"});
const nightFormatter = new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"});
const publicationFormatter = new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:councilTimezone});
export function pacificDate(value: string | Date) {
  const parts = Object.fromEntries(pacificFormatter.formatToParts(new Date(value)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function sessionDate(session: Session) { return session.councilNight ?? pacificDate(session.publishedAt); }
export function datePosition(date: string) { return Math.floor(Date.parse(`${date}T00:00:00Z`)/86400000); }
export function nightLabel(session: Session) {
  const label = nightFormatter.format(new Date(`${sessionDate(session)}T00:00:00Z`));
  return `${session.councilNight ? "Council night" : "Published"} ${label}`;
}
export function publicationLabel(session: Session) {
  return `Published ${publicationFormatter.format(new Date(session.publishedAt))} Pacific${session.councilNight && session.councilNight !== pacificDate(session.publishedAt) ? " · Catch-up review" : ""}`;
}
