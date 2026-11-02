// Pure derivation of an agent's sandbox / permission posture from what the Paseo 0.14 snapshot really carries:
// `features` (toggle/select), `runtimeInfo.extra` (untyped provider bag), `currentModeId` + `availableModes`.
// The protocol has no typed network-access or writable-roots field, so those rows only get a value when a provider
// reports them under a recognisable key, and otherwise read "not reported by provider". No React or daemon imports.

export type PostureSource = "feature" | "runtimeInfo" | "mode" | "none";
export type PostureRow = { key: string; label: string; value: string; source: PostureSource };

export const NOT_REPORTED = "not reported by provider";

type AgentLike = {
  features?: readonly unknown[] | null;
  runtimeInfo?: { modeId?: string | null; extra?: Record<string, unknown> | null } | null;
  currentModeId?: string | null;
  availableModes?: ReadonlyArray<{ id: string; label?: string; description?: string }> | null;
};

const FIELDS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "sandbox", label: "Sandbox", re: /^sandbox(mode|policy)?$/i },
  { key: "approval", label: "Approval policy", re: /^approval(policy|mode)?$/i },
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
    return parts.length ? parts.join(", ") : null;
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

export function sandboxPosture(agent: AgentLike): PostureRow[] {
  const rows: PostureRow[] = [];
  const feats = (agent.features ?? []).filter((f: any) => f && typeof f.id === "string") as any[];
  const extra = agent.runtimeInfo?.extra ?? {};
  for (const field of FIELDS) {
    const f = feats.find((x) => field.re.test(norm(x.id)));
    const fv = f ? featureValue(f) : null;
    if (fv) { rows.push({ key: field.key, label: field.label, value: fv, source: "feature" }); continue; }
    const ek = Object.keys(extra).find((k) => field.re.test(norm(k)));
    const ev = ek ? show(extra[ek]) : null;
    rows.push(ev
      ? { key: field.key, label: field.label, value: ev, source: "runtimeInfo" }
      : { key: field.key, label: field.label, value: NOT_REPORTED, source: "none" });
  }
  const modeId = agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null;
  const m = modeId ? agent.availableModes?.find((x) => x.id === modeId) : undefined;
  rows.unshift(modeId
    ? { key: "mode", label: "Permission mode", value: m?.label ? `${m.label}${m.description ? ` - ${m.description}` : ""}` : modeId, source: "mode" }
    : { key: "mode", label: "Permission mode", value: NOT_REPORTED, source: "none" });
  return rows;
}

export function sourceLabel(s: PostureSource): string {
  return s === "feature" ? "agent feature" : s === "runtimeInfo" ? "runtime info" : s === "mode" ? "agent mode" : "";
}
