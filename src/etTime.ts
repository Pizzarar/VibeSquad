// R15 owner time zone (idea-730): owner-facing clock times render in US Eastern with the zone ("8:00 AM ET").
// Machine fields (ISO strings, logs, JSON) stay UTC; use these only for text the owner reads.
const TZ = "America/New_York";
const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }); // YYYY-MM-DD
const toMs = (v: string | number | Date | null | undefined): number => (v == null || v === "" ? NaN : v instanceof Date ? v.getTime() : new Date(v).getTime());

/** "8:00 AM ET" (empty string for missing/invalid input). */
export function etClock(v: string | number | Date | null | undefined): string {
  const t = toMs(v);
  return Number.isFinite(t) ? `${clockFmt.format(t)} ET` : "";
}
/** "2026-11-25" in ET. */
export function etDate(v: string | number | Date | null | undefined): string {
  const t = toMs(v);
  return Number.isFinite(t) ? dateFmt.format(t) : "";
}
/** "2026-11-25 8:00 AM ET" (full stamp, for tooltips and detail rows). */
export function etDateTime(v: string | number | Date | null | undefined): string {
  const t = toMs(v);
  return Number.isFinite(t) ? `${dateFmt.format(t)} ${etClock(t)}` : "";
}
