// P5d (docs/PLAN_PROFILES_ROLE_ONLY.md): Settings role editor (prompt / tools / modes per role) and the tier ladder
// editor (provider rows x top|mid|cheap). Both write through /__vibesquad/roles (server/roles-api.mjs); the legacy
// profile editor below them keeps old names working until P5f (read-only once a role is saved).
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject, TextareaHTMLAttributes } from "react";
import { Field } from "./TeamActions";
import { EFFORTS, TIERS, fetchRoles, saveLadderRungs, saveRole, useProfiles } from "./profiles";
import type { Ladder, LadderRung, RoleDef, RoleMode, Tier } from "./profiles";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", "antigravity-cli": "Gemini", opencode: "OpenCode" };
const provLabel = (p: string) => PROVIDER_LABEL[p] ?? p;
const KNOWN_PROVIDERS = ["claude", "antigravity-cli", "opencode"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const splitTools = (v: string) => [...new Set(v.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
const errText = (e: unknown) => String((e as Error)?.message ?? e);

/** Effort options; a stored value outside the known list stays selectable so a save never drops it silently. */
function EffortOptions({ value, blank }: { value: string; blank: string }) {
  const extra = value && !(EFFORTS as readonly string[]).includes(value) ? [value] : [];
  return (
    <>
      <option value="">{blank}</option>
      {[...EFFORTS, ...extra].map((e) => (
        <option key={e} value={e}>{e}</option>
      ))}
    </>
  );
}

/**
 * After the next render, focus the first enabled element matching the selectors inside `root`, tried in order (row
 * buttons that disable or unmount would otherwise drop focus to <body>).
 */
function useFocusAfterRender(root: RefObject<HTMLElement | null>) {
  const [target, setTarget] = useState<string[] | null>(null);
  useLayoutEffect(() => {
    if (!target) return;
    for (const sel of target) {
      const el = [...(root.current?.querySelectorAll<HTMLElement>(sel) ?? [])].find((x) => !(x as HTMLButtonElement).disabled);
      if (el) {
        el.focus();
        break;
      }
    }
    setTarget(null);
  }, [target, root]);
  return (...selectors: string[]) => setTarget(selectors);
}

/**
 * One-line text field that wraps instead of clipping (UX r3 M-B): a long model ID stays fully readable in a narrow ladder
 * cell. Newlines are dropped; the height follows the text (or the placeholder when empty) and the cell width.
 */
function WrapField({ value, onValue, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & { value: string; onValue: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const shown = el.value;
      if (!shown && el.placeholder) el.value = el.placeholder; // measure the placeholder too, then restore
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
      el.value = shown;
    };
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(el.parentElement ?? el);
    return () => ro?.disconnect();
  }, [value, rest.placeholder]);
  return (
    <textarea
      ref={ref}
      rows={1}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className="re-wrap"
      value={value}
      {...rest}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
      }}
      onChange={(e) => onValue(e.target.value.replace(/[\r\n]+/g, ""))}
    />
  );
}

type RoleDraft = { role: RoleDef; toolsText: string };
const draftOf = (r: RoleDef): RoleDraft => ({ role: structuredClone(r), toolsText: (r.mcpExtras ?? []).join(", ") });
const roleNorm = (r: RoleDef) => JSON.stringify({ ...r, mcpExtras: r.mcpExtras?.length ? r.mcpExtras : undefined });
const draftDirty = (saved: RoleDef | undefined, d: RoleDraft | undefined) =>
  Boolean(saved && d && roleNorm(saved) !== roleNorm({ ...d.role, mcpExtras: splitTools(d.toolsText) }));

/** Unsaved ladder edits: only the {provider, tier} cells the user touched (a refreshed ladder never re-saves the rest). */
type LadderEdits = Record<string, Partial<Record<Tier, LadderRung>>>;

// Module-level drafts: closing Settings or switching sections keeps unsaved role and ladder edits (a reload drops them).
const draftStore: { roles: Record<string, RoleDraft>; ladder: LadderEdits } = { roles: {}, ladder: {} };
type Updater<T> = T | ((prev: T) => T);
function useStoredDraft<K extends keyof typeof draftStore>(k: K) {
  const [value, setValue] = useState(draftStore[k]);
  const set = (next: Updater<(typeof draftStore)[K]>) => {
    const v = typeof next === "function" ? (next as (prev: (typeof draftStore)[K]) => (typeof draftStore)[K])(draftStore[k]) : next;
    draftStore[k] = v;
    setValue(v);
  };
  return [value, set] as const;
}

export function RoleEditorSection() {
  const { roles, rolesSource } = useProfiles();
  const keys = useMemo(() => Object.keys(roles ?? {}), [roles]);
  const [picked, setKey] = useState("");
  // One unsaved draft per role: switching tabs keeps it (dot on the tab); Save or Discard drops it so the saved role shows.
  const [drafts, setDrafts] = useStoredDraft("roles");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const focusAfter = useFocusAfterRender(rootRef);

  useEffect(() => {
    void fetchRoles();
  }, []);

  const key = picked && roles?.[picked] ? picked : keys[0] ?? "";
  if (!roles || !key) {
    return (
      <section className="ts-team re-section" data-testid="role-editor-section" data-setting-id="role-editor">
        <div className="field-label">ROLES</div>
        <div className="muted small">Loading roles…</div>
      </section>
    );
  }
  const saved = roles[key];
  const cur = drafts[key] ?? draftOf(saved);
  const draft = cur.role;
  const tools = splitTools(cur.toolsText);
  const dirty = draftDirty(saved, drafts[key]);
  const put = (next: RoleDraft) => {
    setDrafts((all) => ({ ...all, [key]: next }));
    setStatus(null);
  };
  const upd = (patch: Partial<RoleDef>) => put({ ...cur, role: { ...draft, ...patch } });
  const updMode = (fam: string, patch: Partial<RoleMode>) => {
    const prev = draft.modes[fam] ?? { modeId: "" };
    upd({ modes: { ...draft.modes, [fam]: { ...prev, ...patch } } });
  };
  const moveProvider = (i: number, d: -1 | 1) => {
    const list = [...draft.providers];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    upd({ providers: list });
    // Keep focus on the moved row; at the edge the pressed arrow disables, so fall back to its sibling.
    const fam = list[j];
    focusAfter(`[data-move="${fam}"][data-dir="${d}"]`, `[data-move="${fam}"]`);
  };
  const removeProvider = (fam: string) => {
    const i = draft.providers.indexOf(fam);
    const list = draft.providers.filter((p) => p !== fam);
    upd({ providers: list });
    const next = list[Math.min(i, list.length - 1)];
    focusAfter(...(next ? [`[data-remove="${next}"]`, `[data-move="${next}"]`] : []), `[data-add-provider="${fam}"]`);
  };
  const select = (k: string) => {
    setKey(k);
    setStatus(null);
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = keys.indexOf(key);
    const to =
      e.key === "ArrowRight" ? keys[(i + 1) % keys.length]
      : e.key === "ArrowLeft" ? keys[(i - 1 + keys.length) % keys.length]
      : e.key === "Home" ? keys[0]
      : e.key === "End" ? keys[keys.length - 1]
      : null;
    if (!to) return;
    e.preventDefault();
    select(to);
    focusAfter(`#role-tab-${CSS.escape(to)}`);
  };
  const unsavedNames = keys.filter((k) => draftDirty(roles[k], drafts[k])).map((k) => roles[k].name);
  const addable = KNOWN_PROVIDERS.filter((p) => !draft.providers.includes(p));
  const onDiscard = () => {
    setDrafts((all) => {
      const { [key]: _drop, ...rest } = all;
      return rest;
    });
    setStatus(null);
  };
  const onSave = async () => {
    setBusy(true);
    try {
      const out: RoleDef = { ...draft, modes: Object.fromEntries(draft.providers.map((p) => [p, draft.modes[p] ?? { modeId: "auto" }])) };
      // Always sent ([] clears): the server merges a PUT over the stored role, so an omitted field would keep old tools.
      out.mcpExtras = tools;
      await saveRole(key, out);
      // Drop the draft: the tab now shows the saved (server-normalized) role, so dirty clears and tools text is tidy.
      setDrafts((all) => {
        const { [key]: _drop, ...rest } = all;
        return rest;
      });
      setStatus({ ok: true, text: `Saved ${draft.name}.` });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={rootRef} className="ts-team re-section" data-testid="role-editor-section" data-setting-id="role-editor">
      <div className="ts-scale-head" style={{ marginBottom: 8 }}>
        <div>
          <div className="field-label">ROLES (prompt · tools · modes)</div>
          <div className="muted small">
            A role is a job, not a model: the model comes from the tier ladder below. A spawn uses the first provider in the
            list that is not at its usage limit.
            {rolesSource === "v1" && " Nothing saved yet: these roles are built from your legacy profiles. The first save stores them (backup: profiles.json.bak-p5)."}
          </div>
        </div>
      </div>
      <div className="re-role-tabs" role="tablist" aria-label="Roles" data-testid="role-editor-tabs">
        {keys.map((k) => {
          const unsaved = draftDirty(roles[k], drafts[k]);
          return (
            <button
              key={k}
              id={`role-tab-${k}`}
              type="button"
              role="tab"
              aria-selected={k === key}
              aria-controls="role-editor-panel"
              tabIndex={k === key ? 0 : -1}
              className={`re-role-tab${k === key ? " on" : ""}`}
              data-testid={`role-tab-${k}`}
              data-unsaved={unsaved ? "true" : undefined}
              onClick={() => select(k)}
              onKeyDown={onTabKey}
            >
              {roles[k].name}
              <span className="re-tier-pip" data-tier={roles[k].tier}>{roles[k].tier}</span>
              {unsaved && <span className="re-dot" title="Unsaved changes" aria-label="unsaved changes" />}
            </button>
          );
        })}
      </div>
      <div className="re-body" role="tabpanel" id="role-editor-panel" aria-labelledby={`role-tab-${key}`}>
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
        <Field label="PROMPT (shared across projects)">
          <textarea rows={5} value={draft.prompt} data-testid="role-prompt" onChange={(e) => upd({ prompt: e.target.value })} />
        </Field>
        <Field label="TOOLS (extra MCP servers, comma separated)">
          <input
            value={cur.toolsText}
            placeholder="playwright, vibesquad"
            data-testid="role-tools"
            onChange={(e) => put({ ...cur, toolsText: e.target.value })}
          />
        </Field>
        <div className="field-label" style={{ marginTop: 4 }}>PROVIDERS &amp; MODES (first = preferred, the rest are the failover order)</div>
        <table className="re-table" data-testid="role-modes-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Provider</th>
              <th>Mode ID</th>
              <th title="The ladder rung's effort wins; this is used when the rung has none. Blank = the provider's default.">
                Effort (if the rung has none)
              </th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {draft.providers.map((fam, i) => {
              const effort = draft.modes[fam]?.effort ?? "";
              return (
                <tr key={fam} data-testid={`role-mode-row-${fam}`}>
                  <td className="re-num">{i + 1}</td>
                  <td><b>{provLabel(fam)}</b> <span className="muted small">{fam}</span></td>
                  <td>
                    <input
                      value={draft.modes[fam]?.modeId ?? ""}
                      aria-label={`${provLabel(fam)} mode ID`}
                      placeholder="auto / accept-edits / build"
                      data-testid={`role-mode-id-${fam}`}
                      onChange={(e) => updMode(fam, { modeId: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={effort}
                      aria-label={`${provLabel(fam)} effort`}
                      data-testid={`role-mode-effort-${fam}`}
                      // Blank = explicitly cleared (null), so a shipped role's effort does not snap back on save.
                      onChange={(e) => updMode(fam, { effort: e.target.value || null })}
                    >
                      <EffortOptions value={effort} blank="provider default" />
                    </select>
                  </td>
                  <td className="re-actions">
                    <button type="button" className="btn ghost small" data-move={fam} data-dir={-1} aria-label={`Move ${provLabel(fam)} up`} disabled={i === 0} onClick={() => moveProvider(i, -1)}>↑</button>
                    <button type="button" className="btn ghost small" data-move={fam} data-dir={1} aria-label={`Move ${provLabel(fam)} down`} disabled={i === draft.providers.length - 1} onClick={() => moveProvider(i, 1)}>↓</button>
                    <button
                      type="button"
                      className="btn ghost small"
                      data-remove={fam}
                      aria-label={`Remove ${provLabel(fam)}`}
                      disabled={draft.providers.length <= 1}
                      onClick={() => removeProvider(fam)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
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
                data-add-provider={p}
                onClick={() => {
                  upd({ providers: [...draft.providers, p], modes: { ...draft.modes, [p]: draft.modes[p] ?? { modeId: "auto" } } });
                  focusAfter(`[data-remove="${p}"]`);
                }}
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
          {dirty && (
            <button type="button" className="btn ghost small" data-testid="discard-role-btn" disabled={busy} onClick={onDiscard}>
              Discard
            </button>
          )}
          {unsavedNames.length > 0 && (
            <span className="muted small" data-testid="role-unsaved-count">
              {unsavedNames.length} {unsavedNames.length === 1 ? "role" : "roles"} unsaved: {unsavedNames.join(", ")}
            </span>
          )}
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

/** A rung as the server will store it: blank fields fall back to the shipped rung (field by field, like loadTierLadder). */
const effectiveRung = (r: LadderRung | undefined, def: LadderRung | undefined): LadderRung => {
  const out: LadderRung = { ...(def ?? {}) };
  const model = r?.model?.trim();
  const effort = r?.effort?.trim();
  if (model) out.model = model;
  if (effort) out.effort = effort;
  return out;
};
const sameRung = (a: LadderRung, b: LadderRung) => (a.model ?? "") === (b.model ?? "") && (a.effort ?? "") === (b.effort ?? "");

export function LadderEditorSection() {
  const { ladder, ladderDefaults, roles } = useProfiles();
  // Only touched cells are kept, over the live ladder: a refresh (role save, other tab) never wipes or re-saves the rest.
  const [edits, setEdits] = useStoredDraft("ladder");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const focusAfter = useFocusAfterRender(rootRef);

  useEffect(() => {
    void fetchRoles();
  }, []);

  if (!ladder) {
    return (
      <section className="ts-team re-section" data-testid="ladder-editor-section" data-setting-id="ladder-editor">
        <div className="field-label">TIER LADDER</div>
        <div className="muted small">Loading ladder…</div>
      </section>
    );
  }
  const provs = Object.keys(ladder);
  const cellOf = (fam: string, tier: Tier): LadderRung => edits[fam]?.[tier] ?? ladder[fam]?.[tier] ?? {};
  const usedBy = (tier: Tier) =>
    Object.values(roles ?? {}).filter((r) => r.tier === tier).map((r) => r.name).join(", ");
  const defOf = (fam: string, tier: Tier) => ladderDefaults?.[fam]?.[tier] ?? {};
  const cellChanged = (fam: string, tier: Tier) =>
    edits[fam]?.[tier] !== undefined &&
    !sameRung(effectiveRung(edits[fam]?.[tier], defOf(fam, tier)), effectiveRung(ladder[fam]?.[tier], defOf(fam, tier)));
  const dirty = provs.some((fam) => TIERS.some((tier) => cellChanged(fam, tier)));
  const editCell = (fam: string, tier: Tier, rung: LadderRung) => {
    setEdits((all) => ({ ...all, [fam]: { ...all[fam], [tier]: rung } }));
    setStatus(null);
  };
  const set = (fam: string, tier: Tier, field: "model" | "effort", value: string) =>
    editCell(fam, tier, { ...cellOf(fam, tier), [field]: value });
  const onSave = async () => {
    setBusy(true);
    try {
      const patch: Ladder = {};
      for (const fam of provs) {
        for (const tier of TIERS) {
          if (!cellChanged(fam, tier)) continue;
          const def = defOf(fam, tier);
          const eff = effectiveRung(edits[fam]?.[tier], def);
          // Equal to the shipped rung = delete the override ({}); otherwise store only the fields that differ.
          const rung: LadderRung = {};
          if ((eff.model ?? "") !== (def.model ?? "")) rung.model = eff.model;
          if ((eff.effort ?? "") !== (def.effort ?? "")) rung.effort = eff.effort;
          patch[fam] = { ...patch[fam], [tier]: rung };
        }
      }
      await saveLadderRungs(patch);
      setEdits({});
      setStatus({ ok: true, text: "Ladder saved." });
    } catch (e) {
      setStatus({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const resetCell = (fam: string, tier: Tier) => {
    editCell(fam, tier, { ...defOf(fam, tier) });
    focusAfter(`[data-testid="ladder-model-${fam}-${tier}"]`);
  };

  return (
    <section ref={rootRef} className="ts-team re-section" data-testid="ladder-editor-section" data-setting-id="ladder-editor">
      <div className="field-label">TIER LADDER (provider × top | mid | cheap)</div>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Each spawn uses one tier: high-stakes work uses Top, simple mechanical work uses Cheap, and everything else uses the
        role&apos;s own tier. The provider the spawn lands on picks the row. A rung&apos;s effort wins over the role&apos;s;
        if neither sets one, the provider default applies.
      </div>
      <table className="re-table re-ladder" data-testid="ladder-table">
        <thead>
          <tr>
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
            <Fragment key={fam}>
              {/* UX r3 M-B: the provider is a full-width row, so the three tier cells share the whole table width and model IDs fit. */}
              <tr className="re-ladder-provrow">
                <th colSpan={TIERS.length} scope="colgroup" id={`ladder-prov-${fam}`}>
                  <b>{provLabel(fam)}</b> <span className="muted small">{fam}</span>
                </th>
              </tr>
              <tr data-testid={`ladder-row-${fam}`}>
                {TIERS.map((tier) => {
                  const r = cellOf(fam, tier);
                  const def = defOf(fam, tier);
                  const changed = !sameRung(effectiveRung(r, def), def);
                  const effort = r.effort ?? "";
                  const fable = /fable/i.test(r.model ?? "");
                  return (
                    <td key={tier} className={changed ? "re-changed" : undefined}>
                      <WrapField
                        value={r.model ?? ""}
                        aria-label={`${provLabel(fam)} ${tier} model`}
                        placeholder={def.model ?? "(provider model)"}
                        data-testid={`ladder-model-${fam}-${tier}`}
                        onValue={(v) => set(fam, tier, "model", v)}
                      />
                      <select
                        className="re-ladder-effort"
                        value={effort}
                        aria-label={`${provLabel(fam)} ${tier} effort`}
                        data-testid={`ladder-effort-${fam}-${tier}`}
                        onChange={(e) => set(fam, tier, "effort", e.target.value)}
                      >
                        <EffortOptions value={effort} blank={def.effort ? `default (${def.effort})` : "role's effort"} />
                      </select>
                      {fable && (
                        <div className="small re-bad" role="alert">Fable is picked per spawn only; it can&apos;t be a ladder rung.</div>
                      )}
                      {changed && (
                        <button
                          type="button"
                          className="btn ghost small re-reset"
                          data-testid={`ladder-reset-${fam}-${tier}`}
                          aria-label={`Reset ${provLabel(fam)} ${tier} to default (${def.model ?? "provider model"}${def.effort ? `, ${def.effort}` : ""})`}
                          title={`Default: ${def.model ?? "provider model"}${def.effort ? ` · ${def.effort}` : ""}`}
                          onClick={() => resetCell(fam, tier)}
                        >
                          ↺ default
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="re-save">
        <button type="button" className="btn ok small" data-testid="save-ladder-btn" disabled={busy || !dirty} onClick={() => void onSave()}>
          {busy ? "Saving…" : "Save ladder"}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn ghost small"
            data-testid="discard-ladder-btn"
            disabled={busy}
            onClick={() => {
              setEdits({});
              setStatus(null);
            }}
          >
            Discard
          </button>
        )}
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
