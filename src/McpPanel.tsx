import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePaseo } from "./paseo";
import { Field } from "./TeamActions";
import { patchDaemonMcp, readDaemonMcp, reloadDaemonMcp, readMcpFile, writeMcpFile, type DaemonMcpSection, type McpFileState } from "./paseoMcp";
import {
  MASKED,
  MCP_FILE,
  applyOp,
  diffLines,
  draftFromView,
  draftToConfig,
  emptyDraft,
  hasChanges,
  maskedJson,
  parseMcpFile,
  validateDraft,
  type McpDraft,
  type McpOp,
  type McpServerView,
  type McpTransport,
} from "./paseoMcpLogic";

interface Pending {
  title: string;
  op: McpOp;
  nextText: string;
}

const TRANSPORT_COLOR: Record<McpTransport, string> = { stdio: "#00f0ff", http: "#4df7a6", sse: "#b88cff" };

function PairRows({
  label,
  rows,
  onChange,
  testid,
}: {
  label: string;
  rows: { key: string; value: string }[];
  onChange: (r: { key: string; value: string }[]) => void;
  testid: string;
}) {
  const [shown, setShown] = useState<Record<number, boolean>>({});
  return (
    <div data-testid={testid}>
      <div className="field-label">{label} (values hidden until revealed)</div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
          <input
            type="text"
            aria-label={`${label} key ${i + 1}`}
            style={{ flex: "1 1 120px", minWidth: 0 }}
            placeholder="KEY"
            value={r.key}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
          />
          <input
            type={shown[i] ? "text" : "password"}
            aria-label={`${label} value ${i + 1}`}
            autoComplete="off"
            style={{ flex: "2 1 160px", minWidth: 0 }}
            placeholder="value"
            value={r.value}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <button type="button" className="btn ghost small" onClick={() => setShown({ ...shown, [i]: !shown[i] })}>
            {shown[i] ? "Hide" : "Reveal"}
          </button>
          <button type="button" className="btn ghost small bad-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn ghost small" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        + {label}
      </button>
    </div>
  );
}

export function McpPanel() {
  const { agents } = usePaseo();
  const cwds = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents.values()) if (a.cwd) set.add(a.cwd);
    return [...set].sort();
  }, [agents]);
  const [cwd, setCwd] = useState("");
  useEffect(() => {
    if (!cwd && cwds.length) setCwd(cwds[0]);
  }, [cwd, cwds]);

  const [file, setFile] = useState<McpFileState | null>(null);
  const [daemon, setDaemon] = useState<DaemonMcpSection | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const parsed = useMemo(() => (file ? parseMcpFile(file.text) : null), [file]);

  const load = useCallback(async () => {
    if (!cwd) return;
    setErr("");
    try {
      const [f, d] = await Promise.all([readMcpFile(cwd), readDaemonMcp().catch(() => null)]);
      if (!mounted.current) return;
      setFile(f);
      setDaemon(d);
    } catch (e) {
      if (mounted.current) setErr(e instanceof Error ? e.message : String(e));
    }
  }, [cwd]);

  useEffect(() => {
    setFile(null);
    setDraft(null);
    setPending(null);
    setRevealed({});
    void load();
  }, [load]);

  const reviewDraft = () => {
    if (!draft || !parsed || parsed.error) return;
    const errs = validateDraft(draft, parsed.servers.map((s) => s.name), editing);
    if (errs.length) {
      setErr(errs.join(" · "));
      return;
    }
    setErr("");
    const name = draft.name.trim();
    const prevRaw = editing ? (parsed.doc.mcpServers as Record<string, unknown> | undefined)?.[editing] : undefined;
    const op: McpOp = { kind: "upsert", name, config: draftToConfig(draft, prevRaw), renameFrom: editing ?? undefined };
    setPending({ title: editing ? `Edit "${editing}"` : `Add "${name}"`, op, nextText: applyOp(parsed.doc, op) });
  };

  const reviewRemove = (s: McpServerView) => {
    if (!parsed) return;
    const op: McpOp = { kind: "remove", name: s.name };
    setPending({ title: `Remove "${s.name}"`, op, nextText: applyOp(parsed.doc, op) });
  };

  const confirm = async () => {
    if (!pending || !file) return;
    setBusy(true);
    setErr("");
    try {
      await writeMcpFile(cwd, pending.nextText, file);
      // New agents read .mcp.json at spawn; the reload makes the daemon re-read its own mcp section too.
      const restart = await reloadDaemonMcp().catch(() => null);
      if (!mounted.current) return;
      setNotice(`${pending.title}: saved to ${MCP_FILE}. Running agents keep their old servers; new agents pick this up.${restart && restart.length ? " Daemon restart needed for: " + restart.join(", ") : ""}`);
      setPending(null);
      setDraft(null);
      setEditing(null);
      await load();
    } catch (e) {
      if (mounted.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const toggleDaemon = async (patch: { enabled?: boolean; injectIntoAgents?: boolean }) => {
    setBusy(true);
    setErr("");
    try {
      const restart = await patchDaemonMcp(patch);
      if (!mounted.current) return;
      setNotice(restart.length ? `Saved. Restart needed for: ${restart.join(", ")}` : "Saved and reloaded.");
      setDaemon(await readDaemonMcp());
    } catch (e) {
      if (mounted.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const diff = useMemo(() => {
    if (!pending || !file || !parsed) return [];
    return diffLines(maskedJson(parsed.doc), maskedJson(parseMcpFile(pending.nextText).doc));
  }, [pending, file, parsed]);
  const maskedOnlyChange = !!pending && !!parsed && !hasChanges(diff) && JSON.stringify(parsed.doc) !== JSON.stringify(parseMcpFile(pending.nextText).doc);

  const setD = (patch: Partial<McpDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div data-testid="mcp-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="muted small">
        Servers agents load. Editable source: project <code>{MCP_FILE}</code> (written through the daemon file API). Env and header values stay hidden
        until you reveal a field. Per-agent MCP status is not exposed by the Paseo client, so there is no live connected/failed view here.
      </div>

      <div className="field-label">DAEMON (config.json · mcp)</div>
      {daemon ? (
        <div data-testid="mcp-daemon" style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={daemon.enabled !== false} disabled={busy} onChange={(e) => void toggleDaemon({ enabled: e.target.checked })} />
            Paseo MCP server enabled
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={daemon.injectIntoAgents} disabled={busy} onChange={(e) => void toggleDaemon({ injectIntoAgents: e.target.checked })} />
            Inject Paseo MCP into agents
          </label>
          {daemon.extraKeys.length > 0 && <span className="muted small">other keys (read-only): {daemon.extraKeys.join(", ")}</span>}
        </div>
      ) : (
        <div className="muted small">Daemon MCP settings unavailable.</div>
      )}

      <div className="field-label">PROJECT</div>
      {cwds.length === 0 ? (
        <div className="muted small" data-testid="mcp-no-projects">No agents yet, so no project folder to read {MCP_FILE} from.</div>
      ) : (
        <select aria-label="Project folder" data-testid="mcp-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} style={{ maxWidth: "100%" }}>
          {cwds.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}

      {err && (
        <div className="stat-alert small" data-testid="mcp-error">
          ⚠ {err}
        </div>
      )}
      {notice && (
        <div className="small" data-testid="mcp-notice" style={{ color: "#00f0ff" }}>
          ✓ {notice}
        </div>
      )}

      {parsed?.error && (
        <div className="stat-alert small" data-testid="mcp-parse-error">
          ⚠ {MCP_FILE}: {parsed.error}. Fix the file in the Files panel before editing servers here.
        </div>
      )}

      {parsed && !parsed.error && (
        <div data-testid="mcp-list">
          <div className="field-label">
            SERVERS · PROJECT SCOPE ({MCP_FILE}){file && !file.exists ? " · file not created yet" : ""}
          </div>
          {parsed.servers.length === 0 && <div className="muted small">No servers in this project.</div>}
          {parsed.servers.map((s) => {
            const open = !!revealed[s.name];
            const pairs = Object.entries(s.transport === "stdio" ? s.env : s.headers);
            return (
              <div key={s.name} data-testid={`mcp-row-${s.name}`} className="ts-team" style={{ borderLeftColor: TRANSPORT_COLOR[s.transport], marginBottom: 6 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <b>{s.name}</b>
                  <span className="pill diag" style={{ color: TRANSPORT_COLOR[s.transport] }}>
                    {s.transport}
                  </span>
                  <span className={`pill diag ${s.enabled ? "ok" : "warn"}`}>{s.enabled ? "enabled" : "disabled"}</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn ghost small" data-testid={`mcp-edit-${s.name}`} onClick={() => { setDraft(draftFromView(s)); setEditing(s.name); setErr(""); setNotice(""); }}>
                    Edit
                  </button>
                  <button type="button" className="btn ghost small bad-btn" data-testid={`mcp-remove-${s.name}`} onClick={() => reviewRemove(s)}>
                    Remove
                  </button>
                </div>
                <div className="small" style={{ wordBreak: "break-all" }}>
                  <code>{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</code>
                </div>
                {pairs.length > 0 && (
                  <div className="small muted" style={{ wordBreak: "break-all" }}>
                    {s.transport === "stdio" ? "env" : "headers"}:{" "}
                    {pairs.map(([k, v]) => `${k}=${open ? v : MASKED}`).join(", ")}{" "}
                    <button type="button" className="btn ghost small" onClick={() => setRevealed({ ...revealed, [s.name]: !open })}>
                      {open ? "Hide" : "Reveal"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {!draft && (
            <button type="button" className="btn small" data-testid="mcp-add" onClick={() => { setDraft(emptyDraft()); setEditing(null); setErr(""); setNotice(""); }}>
              + Add server
            </button>
          )}
        </div>
      )}

      {draft && !pending && (
        <div data-testid="mcp-form" className="ts-team" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="field-label">{editing ? `EDIT ${editing}` : "NEW SERVER"}</div>
          <Field label="NAME">
            <input type="text" data-testid="mcp-f-name" value={draft.name} onChange={(e) => setD({ name: e.target.value })} />
          </Field>
          <Field label="TRANSPORT">
            <select data-testid="mcp-f-transport" value={draft.transport} onChange={(e) => setD({ transport: e.target.value as McpTransport })}>
              <option value="stdio">stdio (local command)</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </Field>
          {draft.transport === "stdio" ? (
            <>
              <Field label="COMMAND">
                <input type="text" data-testid="mcp-f-command" value={draft.command} onChange={(e) => setD({ command: e.target.value })} />
              </Field>
              <Field label="ARGS (one per line)">
                <textarea rows={3} data-testid="mcp-f-args" value={draft.args} onChange={(e) => setD({ args: e.target.value })} />
              </Field>
              <PairRows label="ENV" testid="mcp-f-env" rows={draft.env} onChange={(env) => setD({ env })} />
            </>
          ) : (
            <>
              <Field label="URL">
                <input type="text" data-testid="mcp-f-url" value={draft.url} onChange={(e) => setD({ url: e.target.value })} />
              </Field>
              <PairRows label="HEADERS" testid="mcp-f-headers" rows={draft.headers} onChange={(headers) => setD({ headers })} />
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn small" data-testid="mcp-review" onClick={reviewDraft}>
              Review changes
            </button>
            <button type="button" className="btn ghost small" onClick={() => { setDraft(null); setEditing(null); setErr(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && (
        <div data-testid="mcp-confirm" className="ts-team" style={{ borderLeftColor: "#ff4fd8" }}>
          <div className="field-label">CONFIRM · {pending.title} · {cwd}\{MCP_FILE}</div>
          <div style={{ fontFamily: "monospace", fontSize: 12, overflowX: "auto", border: "1px solid var(--line)", margin: "6px 0" }} data-testid="mcp-diff">
            {diff.length === 0 || !hasChanges(diff) ? (
              <div className="diff-line muted">{maskedOnlyChange ? "Only hidden env / header values change." : "No changes."}</div>
            ) : (
              diff.map((l, i) => (
                <div key={i} className={`diff-line ${l.sign === "+" ? "diff-add" : l.sign === "-" ? "diff-remove" : ""}`}>
                  {l.sign} {l.text}
                </div>
              ))
            )}
          </div>
          <div className="muted small">Values shown as {MASKED}. A backup is not kept, so check the diff.</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button type="button" className="btn small" data-testid="mcp-confirm-apply" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Saving…" : "Confirm and save"}
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setPending(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
