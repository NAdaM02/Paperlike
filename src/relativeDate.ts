import { useEffect, useState } from "react";

const DAY_MS = 86_400_000;
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long" });

/** Local calendar day as a whole number, so DST shifts never skew day counts. */
function dayNumber(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Day number of the Monday that starts d's week. */
function mondayOf(d: Date): number {
  return dayNumber(d) - ((d.getDay() + 6) % 7);
}

/**
 * A short, human label for how long ago a date was, counted in local calendar
 * days and Monday-first weeks:
 *   same day            Today
 *   the day before      Yesterday
 *   earlier this week   the weekday, e.g. Tuesday
 *   the week before     Last week
 *   2 to 4 weeks back   2 weeks ago … 4 weeks ago
 *   the month before    Last month
 *   within 11 months    the month name, e.g. March
 *   the year before     Last year
 *   older               3 years ago
 * Returns "" for invalid or future dates.
 */
export function relativeDay(when: string | Date, now: Date = new Date()): string {
  const d = typeof when === "string" ? new Date(when) : when;
  if (isNaN(d.getTime())) return "";
  const days = dayNumber(now) - dayNumber(d);
  if (days < 0) return "";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const weeks = Math.round((mondayOf(now) - mondayOf(d)) / 7);
  if (weeks === 0) return WEEKDAY.format(d);
  if (weeks === 1) return "Last week";
  const months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
  if (weeks <= 4 || months === 0) return `${weeks} weeks ago`;
  if (months === 1) return "Last month";
  if (months < 12) return MONTH.format(d);
  const years = now.getFullYear() - d.getFullYear();
  return years <= 1 ? "Last year" : `${years} years ago`;
}

/** The current time, refreshed just after each local midnight so labels never go stale. */
export function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const next = new Date(now);
    next.setHours(24, 0, 1, 0);
    const t = window.setTimeout(() => setNow(new Date()), next.getTime() - Date.now());
    return () => window.clearTimeout(t);
  }, [now]);
  return now;
}
