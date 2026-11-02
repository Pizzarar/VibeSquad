// Pure derivation of an agent's sandbox / permission posture from what the Paseo 0.14 snapshot really carries:
// `features` (toggle/select), `runtimeInfo.extra` (untyped provider bag), `currentModeId` + `availableModes`.
// The protocol has no typed network-access or writable-roots field, so those only get a row when a provider
// reports them under a recognisable key; otherwise they are listed in one "Not reported by" line. No React or daemon imports.

export type PostureSource = "feature" | "runtimeInfo" | "mode";
export type PostureRow = { key: string; label: string; value: string; full: string; source: PostureSource };
export type Posture = { rows: PostureRow[]; missing: string[]; provider: string };

export const MAX_VALUE = 160;
export const MAX_ITEMS = 8;
export const cap = (s: string, n = MAX_VALUE) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type AgentLike = {
  provider?: string | null;
  features?: readonly unknown[] | null;
  runtimeInfo?: { provider?: string | null; modeId?: string | null; extra?: Record<string, unknown> | null } | null;
  currentModeId?: string | null;
  availableModes?: ReadonlyArray<{ id: string; label?: string; description?: string }> | null;
};

// optional: true fields are never listed as "not reported" (only shown when a provider has them).
const FIELDS: Array<{ key: string; label: string; re: RegExp; optional?: boolean }> = [
  { key: "sandbox", label: "Sandbox", re: /^sandbox(mode|policy)?$/i },
  { key: "approval", label: "Approval policy", re: /^approval(policy|mode)?$/i },
  { key: "shareMcp", label: "Shares Paseo tools", re: /^sharemcp$/i, optional: true },
  { key: "network", label: "Network access", re: /^network(access)?$/i },
  { key: "allowlist", label: "Network allowlist", re: /^(network)?(allowlist|allowedhosts|alloweddomains)$/i },
  { key: "roots", label: "Writable roots", re: /^(writableroots|writabledirs|allowedpaths)$/i },
];

const norm = (id: string) => id.replace(/[-_\s]/g, "");

function show(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(show).filter((x): x is string => !!x);
    if (!parts.length) return null;
    return parts.length > MAX_ITEMS ? `${parts.slice(0, MAX_ITEMS).join(", ")} (+${parts.length - MAX_ITEMS} more)` : parts.join(", ");
  }
  return null; // nested objects are not guessed at
}

function featureValue(f: any): string | null {
  if (f.type === "toggle") return f.value ? "on" : "off";
  if (f.type === "select") {
    if (f.value == null) return null;
    const opt = Array.isArray(f.options) ? f.options.find((o: any) => o?.id === f.value) : null;
    return String(opt?.label || f.value);
  }
  return null;
}

export function sandboxPosture(agent: AgentLike): Posture {
  const rows: PostureRow[] = [];
  const missing: string[] = [];
  const feats = (agent.features ?? []).filter((f: any) => f && typeof f.id === "string") as any[];
  const extra = agent.runtimeInfo?.extra ?? {};
  const push = (key: string, label: string, raw: string, source: PostureSource) =>
    rows.push({ key, label, value: cap(raw), full: raw, source });

  const modeId = agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null;
  if (modeId) {
    const m = agent.availableModes?.find((x) => x.id === modeId);
    push("mode", "Permission mode", m?.label ? `${m.label}${m.description ? ` - ${m.description}` : ""}` : modeId, "mode");
  } else missing.push("permission mode");

  for (const field of FIELDS) {
    const f = feats.find((x) => field.re.test(norm(x.id)));
    const fv = f ? featureValue(f) : null;
    if (fv) { push(field.key, field.label, fv, "feature"); continue; }
    const ek = Object.keys(extra).find((k) => field.re.test(norm(k)));
    const ev = ek ? show(extra[ek]) : null;
    if (ev) push(field.key, field.label, ev, "runtimeInfo");
    else if (!field.optional) missing.push(field.label.toLowerCase());
  }
  return { rows, missing, provider: agent.runtimeInfo?.provider ?? agent.provider ?? "provider" };
}

export function missingLine(p: Posture): string {
  return p.missing.length ? `Not reported by ${p.provider}: ${p.missing.join(", ")}` : "";
}

export function sourceLabel(s: PostureSource): string {
  return s === "feature" ? "agent feature" : s === "runtimeInfo" ? "runtime info" : "agent mode";
}
