const DAY = 86_400_000;
// Date.toLocaleDateString constructs a formatter for each call. The timeline
// needs both labels for 91 days on each render, so reuse the locale formatters.
const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fullFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });

export const timelineDayLabel = (day: number) => dayFormatter.format(new Date(day * DAY));
export const timelineFullLabel = (day: number) => fullFormatter.format(new Date(day * DAY));

export type TimelineGeometry = { width: number; left: number; right: number };
export function retainTimelineGeometry(previous: TimelineGeometry, next: TimelineGeometry): TimelineGeometry {
  return previous.width === next.width && previous.left === next.left && previous.right === next.right ? previous : next;
}
