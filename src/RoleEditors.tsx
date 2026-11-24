// P5d (docs/PLAN_PROFILES_ROLE_ONLY.md): Settings role editor (prompt / tools / modes per role) and the tier ladder
// editor (provider rows x top|mid|cheap). Both write through /__vibesquad/roles (server/roles-api.mjs); the legacy
// profile editor next to them keeps working until P5f.
import { useEffect, useMemo, useState } from "react";
import { Field } from "./TeamActions";
import { TIERS, fetchRoles, saveLadderRungs, saveRole, useProfiles } from "./profiles";
import type { Ladder, RoleDef, RoleMode, Tier } from "./profiles";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", "antigravity-cli": "Gemini", opencode: "OpenCode" };
const provLabel = (p: string) => PROVIDER_LABEL[p] ?? p;
const KNOWN_PROVIDERS = ["claude", "antigravity-cli", "opencode"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const splitTools = (v: string) => [...new Set(v.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

export function RoleEditorSection() {
  const { roles, rolesSource } = useProfiles();
  const keys = useMemo(() => Object.keys(roles ?? {}), [roles]);
  const [key, setKey] = useState("");
  const [draft, setDraft] = useState<RoleDef | null>(null);
  const [toolsText, setToolsText] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchRoles();
  }, []);
  useEffect(() => {
    if (!roles) return;
    const k = key && roles[key] ? key : keys[0] ?? "";
    if (k !== key) setKey(k);
    const src = roles[k];
    if (src && (!draft || k !== key)) {
      setDraft(structuredClone(src));
      setToolsText((src.mcpExtras ?? []).join(", "));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles, key]);

  if (!roles || !draft) {
    return (
      <section className="ts-team re-section" data-testid="role-editor-section" data-setting-id="role-editor">
        <div className="field-label">ROLES</div>
        <div className="muted small">Loading roles…</div>
      </section>
    );
  }
  const saved = roles[key];
  const tools = splitTools(toolsText);
  const norm = (r: RoleDef) => JSON.stringify({ ...r, mcpExtras: r.mcpExtras?.length ? r.mcpExtras : undefined });
  const dirty = norm(saved) !== norm({ ...draft, mcpExtras: tools });
  const upd = (patch: Partial<RoleDef>) => {
    setDraft({ ...draft, ...patch });
    setStatus(null);
  };
  const updMode = (fam: string, patch: Partial<RoleMode>) => {
    const cur = draft.modes[fam] ?? { modeId: "" };
    const next = { ...cur, ...patch };
    if (!next.effort) delete next.effort;
    upd({ modes: { ...draft.modes, [fam]: next } });
  };
  const moveProvider = (i: number, d: -1 | 1) => {
    const list = [...draft.providers];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    upd({ providers: list });
  };
  const addable = KNOWN_PROVIDERS.filter((p) => !draft.providers.includes(p));
  const onSave = async () => {
    setBusy(true);
    try {
      const out: RoleDef = { ...draft, modes: Object.fromEntries(draft.providers.map((p) => [p, draft.modes[p] ?? { modeId: "auto" }])) };
      if (tools.length) out.mcpExtras = tools;
      else delete out.mcpExtras;
      await saveRole(key, out);
      setStatus({ ok: true, text: `Saved ${draft.name}.` });
    } catch (e) {
      setStatus({ ok: false, text: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ts-team re-section" data-testid="role-editor-section" data-setting-id="role-editor">
      <div className="ts-scale-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="field-label">ROLES (prompt · tools · modes)</div>
          <div className="muted small">
            A role is a job, not a model: the model comes from the tier ladder below. Spawns pick the first provider that is
            not capped.
            {rolesSource === "v1" && " Nothing saved yet: roles are built from your legacy profiles; the first save writes them (backup: profiles.json.bak-p5)."}
          </div>
        </div>
      </div>
      <div className="re-role-tabs" role="tablist" data-testid="role-editor-tabs">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === key}
            className={`re-role-tab${k === key ? " on" : ""}`}
            data-testid={`role-tab-${k}`}
            onClick={() => {
              setKey(k);
              setDraft(structuredClone(roles[k]));
              setToolsText((roles[k].mcpExtras ?? []).join(", "));
              setStatus(null);
            }}
          >
            {roles[k].name}
            <span className="re-tier-pip" data-tier={roles[k].tier}>{roles[k].tier}</span>
          </button>
        ))}
      </div>
      <div className="re-body">
        <div className="row2">
          <Field label="ROLE NAME">
            <input value={draft.name} data-testid="role-name" onChange={(e) => upd({ name: e.target.value })} />
          </Field>
          <Field label="TIER (default rung of the ladder)">
            <select value={draft.tier} data-testid="role-tier" onChange={(e) => upd({ tier: e.target.value as Tier })}>
              {TIERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="PROMPT (project-neutral system prompt layer)">
          <textarea rows={5} value={draft.prompt} data-testid="role-prompt" onChange={(e) => upd({ prompt: e.target.value })} />
        </Field>
        <Field label="TOOLS (extra MCP servers, comma separated)">
          <input
            value={toolsText}
            placeholder="playwright, vibesquad"
            data-testid="role-tools"
            onChange={(e) => {
              setToolsText(e.target.value);
              setStatus(null);
            }}
          />
        </Field>
        <div className="field-label" style={{ marginTop: 4 }}>PROVIDERS &amp; MODES (first = preferred, the rest are the failover order)</div>
        <table className="re-table" data-testid="role-modes-table">
          <thead>
            <tr><th>#</th><th>Provider</th><th>Mode ID</th><th>Thinking / effort</th><th aria-label="actions" /></tr>
          </thead>
          <tbody>
            {draft.providers.map((fam, i) => (
              <tr key={fam} data-testid={`role-mode-row-${fam}`}>
                <td className="re-num">{i + 1}</td>
                <td><b>{provLabel(fam)}</b> <span className="muted small">{fam}</span></td>
                <td>
                  <input
                    value={draft.modes[fam]?.modeId ?? ""}
                    placeholder="auto / accept-edits / build"
                    data-testid={`role-mode-id-${fam}`}
                    onChange={(e) => updMode(fam, { modeId: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={draft.modes[fam]?.effort ?? ""}
                    placeholder="(ladder rung)"
                    data-testid={`role-mode-effort-${fam}`}
                    onChange={(e) => updMode(fam, { effort: e.target.value })}
                  />
                </td>
                <td className="re-actions">
                  <button type="button" className="btn ghost small" aria-label={`Move ${provLabel(fam)} up`} disabled={i === 0} onClick={() => moveProvider(i, -1)}>↑</button>
                  <button type="button" className="btn ghost small" aria-label={`Move ${provLabel(fam)} down`} disabled={i === draft.providers.length - 1} onClick={() => moveProvider(i, 1)}>↓</button>
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label={`Remove ${provLabel(fam)}`}
                    disabled={draft.providers.length <= 1}
                    onClick={() => upd({ providers: draft.providers.filter((p) => p !== fam) })}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {addable.length > 0 && (
          <div className="re-add">
            <span className="muted small">Add provider:</span>
            {addable.map((p) => (
              <button
                key={p}
                type="button"
                className="btn ghost small"
                data-testid={`role-add-provider-${p}`}
                onClick={() => upd({ providers: [...draft.providers, p], modes: { ...draft.modes, [p]: draft.modes[p] ?? { modeId: "auto" } } })}
              >
                + {provLabel(p)}
              </button>
            ))}
          </div>
        )}
        <div className="re-save">
          <button type="button" className="btn ok small" data-testid="save-role-btn" disabled={busy || !dirty} onClick={() => void onSave()}>
            {busy ? "Saving…" : `Save role (${draft.name})`}
          </button>
          {dirty && <span className="muted small">unsaved changes</span>}
          {status && (
            <span className={`small ${status.ok ? "re-ok" : "re-bad"}`} role={status.ok ? "status" : "alert"} data-testid="role-save-status">
              {status.text}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

export function LadderEditorSection() {
  const { ladder, ladderDefaults, roles } = useProfiles();
  const [draft, setDraft] = useState<Ladder | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchRoles();
  }, []);
  useEffect(() => {
    if (ladder) setDraft(structuredClone(ladder));
  }, [ladder]);

  if (!ladder || !draft) {
    return (
      <section className="ts-team re-section" data-testid="ladder-editor-section" data-setting-id="ladder-editor">
        <div className="field-label">TIER LADDER</div>
        <div className="muted small">Loading ladder…</div>
      </section>
    );
  }
  const provs = Object.keys(draft);
  const usedBy = (tier: Tier) =>
    Object.values(roles ?? {}).filter((r) => r.tier === tier).map((r) => r.name).join(", ");
  const dirty = !same(draft, ladder);
  const set = (fam: string, tier: Tier, field: "model" | "effort", value: string) => {
    const rung = { ...(draft[fam]?.[tier] ?? {}), [field]: value };
    setDraft({ ...draft, [fam]: { ...draft[fam], [tier]: rung } });
    setStatus(null);
  };
  const onSave = async () => {
    setBusy(true);
    try {
      const patch: Ladder = {};
      for (const fam of provs) {
        for (const tier of TIERS) {
          const cur = draft[fam]?.[tier] ?? {};
          if (same(cur, ladder[fam]?.[tier] ?? {})) continue;
          patch[fam] = { ...patch[fam], [tier]: { model: (cur.model ?? "").trim(), effort: (cur.effort ?? "").trim() } };
        }
      }
      await saveLadderRungs(patch);
      setStatus({ ok: true, text: "Ladder saved." });
    } catch (e) {
      setStatus({ ok: false, text: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  const resetFam = (fam: string, tier: Tier) => {
    const def = ladderDefaults?.[fam]?.[tier] ?? {};
    setDraft({ ...draft, [fam]: { ...draft[fam], [tier]: { ...def } } });
  };

  return (
    <section className="ts-team re-section" data-testid="ladder-editor-section" data-setting-id="ladder-editor">
      <div className="field-label">TIER LADDER (provider × top | mid | cheap)</div>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Stakes pick a tier (tierA → top, mechanical → cheap, otherwise the role&apos;s tier); the provider the spawn lands on picks the row.
        A blank effort uses the role&apos;s own. Fable is explicit-only and cannot be a rung.
      </div>
      <table className="re-table re-ladder" data-testid="ladder-table">
        <thead>
          <tr>
            <th>Provider</th>
            {TIERS.map((t) => (
              <th key={t}>
                <span className="re-tier-pip" data-tier={t}>{t}</span>
                <div className="muted small re-roles-of">{usedBy(t) || "no roles"}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {provs.map((fam) => (
            <tr key={fam} data-testid={`ladder-row-${fam}`}>
              <td><b>{provLabel(fam)}</b><div className="muted small">{fam}</div></td>
              {TIERS.map((tier) => {
                const r = draft[fam]?.[tier] ?? {};
                const def = ladderDefaults?.[fam]?.[tier] ?? {};
                const changed = !same(r, def);
                return (
                  <td key={tier} className={changed ? "re-changed" : undefined}>
                    <input
                      value={r.model ?? ""}
                      aria-label={`${provLabel(fam)} ${tier} model`}
                      placeholder="(profile model)"
                      data-testid={`ladder-model-${fam}-${tier}`}
                      onChange={(e) => set(fam, tier, "model", e.target.value)}
                    />
                    <div className="re-effort-row">
                      <input
                        value={r.effort ?? ""}
                        aria-label={`${provLabel(fam)} ${tier} effort`}
                        placeholder="effort"
                        data-testid={`ladder-effort-${fam}-${tier}`}
                        onChange={(e) => set(fam, tier, "effort", e.target.value)}
                      />
                      {changed && (
                        <button type="button" className="btn ghost small" title={`Back to default (${def.model ?? "profile"}${def.effort ? ` · ${def.effort}` : ""})`} onClick={() => resetFam(fam, tier)}>
                          ↺
                        </button>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="re-save">
        <button type="button" className="btn ok small" data-testid="save-ladder-btn" disabled={busy || !dirty} onClick={() => void onSave()}>
          {busy ? "Saving…" : "Save ladder"}
        </button>
        {dirty && <span className="muted small">unsaved changes</span>}
        {status && (
          <span className={`small ${status.ok ? "re-ok" : "re-bad"}`} role={status.ok ? "status" : "alert"} data-testid="ladder-save-status">
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}
