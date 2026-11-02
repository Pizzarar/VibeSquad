import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listProjects } from "./paseoWorkspaces";
import {
  createConfigDoc, deleteConfigDoc, getSkillsStatus, listConfigFiles, readConfigDoc, reconcileSkills, saveConfigDoc,
  saveSkillsSelection, tryReadConfigDoc, uninstallSkills,
  type ConfigFile, type SkillSelection, type SkillsSaveResult, type SkillsStatus,
} from "./paseoSkills";
import {
  AGENT_KEYS, COMMAND_KEYS, DIRS, SUBAGENT_MODELS, agentTemplate, commandTemplate, fileNameFor, hookRows, normalizeName,
  parseFrontmatter, parseSettingsJson, serializeFrontmatter, stemOf, validateAgent, validateCommand,
  type ConfigKind, type HookRow,
} from "./claudeConfigLogic";
import { ConfirmButton } from "./ui";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const USER_SCOPE = "__user__";
const CUSTOM_SCOPE = "__custom__";

// ---------------------------------------------------------------- Paseo agent skills

function PaseoSkillsSection() {
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [mode, setMode] = useState<"all" | "custom">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<SkillsSaveResult["confirmationRequired"]>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const apply = useCallback((s: SkillsStatus) => {
    setStatus(s);
    setMode(s.selection.mode);
    setPicked(new Set(s.selection.mode === "custom" ? s.selection.skills : s.available));
  }, []);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(() => run(async () => apply(await getSkillsStatus())), [run, apply]);
  useEffect(() => void load(), [load]);

  const save = (confirmed?: string[]) =>
    run(async () => {
      const sel: SkillSelection = mode === "all" ? { mode: "all" } : { mode: "custom", skills: [...picked] };
      const r = await saveSkillsSelection(sel, confirmed);
      if (r.confirmationRequired) {
        setPending(r.confirmationRequired);
        return;
      }
      setPending(null);
      apply(r);
      setNote("Selection saved.");
    });

  const stateTone = status?.state === "up-to-date" ? "ok" : status?.state === "drift" ? "warn" : "";

  return (
    <div className="skills-block" data-testid="skills-paseo">
      <div className="field-label">PASEO AGENT SKILLS</div>
      {err && <div className="paseo-ops-err" data-testid="skills-paseo-error">{err}</div>}
      {!status ? (
        <div className="muted small">{busy ? "Loading…" : "Status unavailable."}</div>
      ) : (
        <>
          <div className="paseo-ops-row">
            <span className={`pill diag ${stateTone}`} data-testid="skills-paseo-state">{status.state}</span>
            <span className="muted small">{status.installed.length} installed of {status.available.length} available</span>
            {status.ops.length > 0 && (
              <span className="muted small" data-testid="skills-paseo-ops">
                pending: {status.ops.map((o) => `${o.kind} ${o.name}`).join(", ")}
              </span>
            )}
          </div>
          <div className="paseo-ops-row">
            <label className="skills-radio">
              <input type="radio" name="skills-mode" checked={mode === "all"} onChange={() => setMode("all")} /> All skills
            </label>
            <label className="skills-radio">
              <input type="radio" name="skills-mode" checked={mode === "custom"} onChange={() => setMode("custom")} /> Custom selection
            </label>
          </div>
          {mode === "custom" && (
            <div className="skills-checks" data-testid="skills-paseo-list">
              {status.available.map((n) => (
                <label key={n} className="skills-radio">
                  <input
                    type="checkbox"
                    checked={picked.has(n)}
                    onChange={(e) => setPicked((p) => { const s = new Set(p); if (e.target.checked) s.add(n); else s.delete(n); return s; })}
                  />{" "}
                  {n} {status.installed.includes(n) ? <span className="muted small">(installed)</span> : null}
                </label>
              ))}
            </div>
          )}
          {mode === "all" && status.available.length > 0 && <div className="muted small">Available: {status.available.join(", ")}</div>}
          {pending && (
            <div className="skills-warn" data-testid="skills-paseo-confirm">
              Saving will remove: <b>{pending.removals.join(", ")}</b>.{" "}
              <button type="button" className="btn small" disabled={busy} onClick={() => void save(pending.removals)}>Confirm removals</button>{" "}
              <button type="button" className="btn ghost small" onClick={() => setPending(null)}>Cancel</button>
            </div>
          )}
          <div className="paseo-ops-row">
            <button type="button" className="btn small" disabled={busy} data-testid="skills-paseo-save" onClick={() => void save()}>Save selection</button>
            <button type="button" className="btn ghost small" disabled={busy} data-testid="skills-paseo-reconcile" onClick={() => void run(async () => apply(await reconcileSkills()))}>Reconcile</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void load()}>Refresh</button>
            <ConfirmButton
              label="Uninstall all"
              armedLabel="Tap to uninstall"
              busyLabel="Uninstalling…"
              tone="danger"
              onConfirm={() => run(async () => { apply(await uninstallSkills()); setNote("Paseo skills uninstalled."); })}
            />
            {note && <span className="muted small" data-testid="skills-paseo-note">{note}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- commands + subagents

interface Draft {
  editing: string | null; // stem of the file being edited, null = new
  name: string;
  fields: Record<string, string>;
  order: string[];
  body: string;
  base: { modifiedAt: string; revision?: string } | null;
  path: string | null;
}

function ConfigSection({ kind, cwd }: { kind: ConfigKind; cwd: string }) {
  const isAgent = kind === "agent";
  const dir = DIRS[kind];
  const keys = isAgent ? AGENT_KEYS : COMMAND_KEYS;
  const label = isAgent ? "SUBAGENTS" : "CUSTOM SLASH COMMANDS";
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<{ name: string; text: string } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const stems = useMemo(() => files.map((f) => stemOf(f.name)), [files]);

  const reload = useCallback(async () => {
    if (!cwd) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const list = await listConfigFiles(cwd, dir);
      if (my === seq.current) setFiles(list);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [cwd, dir]);

  useEffect(() => {
    setDraft(null);
    setView(null);
    setErr("");
    setFiles([]);
    void reload();
  }, [reload]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    const t = (isAgent ? agentTemplate : commandTemplate)("my-" + kind);
    setView(null);
    setDraft({ editing: null, name: "", fields: t.fields, order: Object.keys(t.fields), body: t.body, base: null, path: null });
  };

  const open = (f: ConfigFile, edit: boolean) =>
    guard(async () => {
      const doc = await readConfigDoc(cwd, f.path);
      if (!edit) {
        setDraft(null);
        setView({ name: f.name, text: doc.text });
        return;
      }
      const p = parseFrontmatter(doc.text);
      setView(null);
      setDraft({ editing: stemOf(f.name), name: stemOf(f.name), fields: p.fields, order: p.order, body: p.body, base: doc, path: f.path });
    });

  const setField = (k: string, v: string) => setDraft((d) => (d ? { ...d, fields: { ...d.fields, [k]: v } } : d));

  const submit = () =>
    guard(async () => {
      if (!draft) return;
      const name = normalizeName(draft.name);
      const fields = { ...draft.fields };
      if (isAgent) fields.name = name;
      const problem = (isAgent ? validateAgent : validateCommand)(name, fields, draft.body, stems, draft.editing);
      if (problem) throw new Error(problem);
      const content = serializeFrontmatter(fields, draft.body, keys, draft.order);
      if (draft.path && draft.base) await saveConfigDoc(cwd, draft.path, content, draft.base);
      else await createConfigDoc(cwd, dir, fileNameFor(name), content);
      setDraft(null);
      await reload();
    });

  const remove = (f: ConfigFile) =>
    guard(async () => {
      await deleteConfigDoc(cwd, f.path);
      setView(null);
      setDraft((d) => (d?.path === f.path ? null : d));
      await reload();
    });

  const t = (s: string) => `skills-${kind}-${s}`;

  return (
    <div className="skills-block" data-testid={t("section")}>
      <div className="field-label">{label} <span className="muted small">{dir}/</span></div>
      {err && <div className="paseo-ops-err" data-testid={t("error")}>{err}</div>}
      <div className="paseo-ops-row">
        <button type="button" className="btn small" disabled={busy || !cwd} data-testid={t("new")} onClick={startNew}>+ New {isAgent ? "subagent" : "command"}</button>
        <button type="button" className="btn ghost small" disabled={loading} onClick={() => void reload()}>Refresh</button>
        <span className="muted small">{loading ? "Loading…" : `${files.length} file(s)`}</span>
      </div>
      {files.map((f) => (
        <div key={f.path} className="skills-item" data-testid={t(`item-${stemOf(f.name)}`)}>
          <b className="skills-item-name">{isAgent ? "" : "/"}{stemOf(f.name)}</b>
          <span className="skills-item-actions">
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void open(f, false)}>View</button>
            <button type="button" className="btn ghost small" disabled={busy} data-testid={t(`edit-${stemOf(f.name)}`)} onClick={() => void open(f, true)}>Edit</button>
            <ConfirmButton label="Delete" armedLabel="Tap to delete" busyLabel="Deleting…" tone="danger" onConfirm={() => remove(f)} />
          </span>
        </div>
      ))}
      {!loading && files.length === 0 && <div className="muted small">None yet in this scope.</div>}
      {view && (
        <div className="skills-view">
          <div className="paseo-ops-row"><b>{view.name}</b><button type="button" className="btn ghost small" onClick={() => setView(null)}>Close</button></div>
          <pre className="paseo-ops-pre" data-testid={t("view")}>{view.text}</pre>
        </div>
      )}
      {draft && (
        <div className="skills-form" data-testid={t("form")}>
          <label className="skills-field">
            <span className="field-label">NAME</span>
            <input data-testid={t("name")} value={draft.name} disabled={draft.editing !== null} placeholder={isAgent ? "code-reviewer" : "review-pr"} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="skills-field">
            <span className="field-label">DESCRIPTION</span>
            <input data-testid={t("description")} value={draft.fields.description ?? ""} onChange={(e) => setField("description", e.target.value)} />
          </label>
          {isAgent ? (
            <>
              <label className="skills-field">
                <span className="field-label">TOOLS <span className="muted small">comma-separated, blank = inherit all</span></span>
                <input data-testid={t("tools")} value={draft.fields.tools ?? ""} onChange={(e) => setField("tools", e.target.value)} />
              </label>
              <label className="skills-field">
                <span className="field-label">MODEL</span>
                <select data-testid={t("model")} value={draft.fields.model ?? ""} onChange={(e) => setField("model", e.target.value)}>
                  {SUBAGENT_MODELS.map((m) => <option key={m} value={m}>{m || "(default)"}</option>)}
                  {draft.fields.model && !(SUBAGENT_MODELS as readonly string[]).includes(draft.fields.model) && <option value={draft.fields.model}>{draft.fields.model}</option>}
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="skills-field">
                <span className="field-label">ARGUMENT HINT</span>
                <input data-testid={t("argument-hint")} value={draft.fields["argument-hint"] ?? ""} onChange={(e) => setField("argument-hint", e.target.value)} />
              </label>
              <label className="skills-field">
                <span className="field-label">ALLOWED TOOLS <span className="muted small">e.g. Bash(git status:*), Read</span></span>
                <input data-testid={t("allowed-tools")} value={draft.fields["allowed-tools"] ?? ""} onChange={(e) => setField("allowed-tools", e.target.value)} />
              </label>
              <label className="skills-field">
                <span className="field-label">MODEL <span className="muted small">optional</span></span>
                <input data-testid={t("model")} value={draft.fields.model ?? ""} onChange={(e) => setField("model", e.target.value)} />
              </label>
            </>
          )}
          <label className="skills-field">
            <span className="field-label">{isAgent ? "SYSTEM PROMPT" : "PROMPT"}</span>
            <textarea data-testid={t("body")} rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          <div className="paseo-ops-row">
            <button type="button" className="btn small" disabled={busy} data-testid={t("save")} onClick={() => void submit()}>{draft.editing ? "Save changes" : "Create"}</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- hooks (read-only)

function HooksSection({ cwd }: { cwd: string }) {
  const [rows, setRows] = useState<HookRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    const out: HookRow[] = [];
    const warn: string[] = [];
    for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
      const doc = await tryReadConfigDoc(cwd, f);
      if (!doc) continue;
      const parsed = parseSettingsJson(doc.text);
      if (parsed.error) warn.push(`${f}: invalid JSON (${parsed.error})`);
      else out.push(...hookRows(parsed.value, f.replace(".claude/", "")));
    }
    setRows(out);
    setNotes(warn);
    setLoading(false);
  }, [cwd]);
  useEffect(() => void load(), [load]);

  return (
    <div className="skills-block" data-testid="skills-hooks">
      <div className="field-label">HOOKS <span className="muted small">read-only · edit in .claude/settings.json</span></div>
      <div className="paseo-ops-row">
        <button type="button" className="btn ghost small" disabled={loading} onClick={() => void load()}>Refresh</button>
        <span className="muted small">{loading ? "Loading…" : `${rows.length} hook(s)`}</span>
      </div>
      {notes.map((n) => <div key={n} className="paseo-ops-err">{n}</div>)}
      {rows.map((r, i) => (
        <div key={i} className="skills-item skills-hook" data-testid="skills-hook-row">
          <span className="pill diag">{r.event}</span>
          {r.matcher && <span className="muted small">match: {r.matcher}</span>}
          <span className="muted small">{r.source}</span>
          <code className="skills-hook-cmd">{r.type !== "command" ? `[${r.type}] ` : ""}{r.command}</code>
        </div>
      ))}
      {!loading && rows.length === 0 && <div className="muted small">No hooks configured for this project.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- panel

export function SkillsPanel() {
  const [projects, setProjects] = useState<{ id: string; name: string; root: string }[]>([]);
  const [scope, setScope] = useState("");
  const [userHome, setUserHome] = useState("");
  const [custom, setCustom] = useState("");

  useEffect(() => {
    let alive = true;
    listProjects()
      .then((ps) => {
        if (!alive) return;
        const rows = ps.map((p) => ({ id: p.projectId, name: p.projectDisplayName, root: p.projectRootPath }));
        setProjects(rows);
        setScope((s) => s || rows[0]?.root || "");
      })
      .catch(() => {});
    // The daemon home is `<user home>/.paseo`; its parent is where `~/.claude` lives.
    fetch("/__vibesquad/paseo/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const h = typeof d?.home === "string" ? d.home : "";
        const m = /^(.*)[\\/]\.paseo[\\/]?$/.exec(h);
        if (alive && m) setUserHome(m[1]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const isUser = scope === USER_SCOPE;
  const cwd = isUser ? userHome : scope === CUSTOM_SCOPE ? custom.trim() : scope;

  return (
    <div className="paseo-ops skills-panel" data-testid="paseo-panel-skills">
      <PaseoSkillsSection />

      <div className="skills-block">
        <div className="field-label">SCOPE FOR COMMANDS, SUBAGENTS AND HOOKS</div>
        <select data-testid="skills-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          {projects.length === 0 && <option value="">(no projects)</option>}
          {projects.map((p) => <option key={p.id} value={p.root}>{p.name} · project</option>)}
          {userHome && <option value={USER_SCOPE}>User · ~/.claude</option>}
          <option value={CUSTOM_SCOPE}>Custom folder…</option>
        </select>
        {scope === CUSTOM_SCOPE && (
          <input data-testid="skills-custom-cwd" value={custom} placeholder="Absolute path of a project or worktree" onChange={(e) => setCustom(e.target.value)} />
        )}
        <div className="muted small skills-cwd" data-testid="skills-cwd">{cwd || "(pick a project)"}</div>
      </div>

      <ConfigSection kind="command" cwd={cwd} />
      <ConfigSection kind="agent" cwd={cwd} />
      <HooksSection cwd={cwd} />
    </div>
  );
}
