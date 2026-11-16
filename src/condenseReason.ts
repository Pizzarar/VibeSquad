/**
 * R4-4: condense an error reason so the cause survives truncation: URLs shrink to their host and a trailing
 * ": <cause>" moves to the front. `Post "https://cloudcode-pa.googleapis.com/v1internal:x": EOF`
 * becomes `EOF · Post cloudcode-pa.googleapis.com`. Text without that shape is only URL-shortened.
 */
export function condenseReason(text: string): string {
  if (!text) return text;
  const hostOnly = text.replace(/https?:\/\/([^\s/"')]+)[^\s"')]*/g, "$1");
  const m = /^(.*?)"?\s*:\s*([^:"\s][^:"]*)$/.exec(hostOnly);
  if (!m) return hostOnly;
  const head = m[1].replace(/["']/g, "").trim();
  const cause = m[2].trim();
  return head && cause && cause.length <= 60 && hostOnly !== text ? `${cause} · ${head}` : hostOnly;
}
