import { useCallback, useEffect, useRef, useState } from "react";
import { addSavedRule, agentCwd, loadRuleFiles, removeSavedRule, type RuleFile } from "./paseoPermissions";
import { DEFAULT_SETTINGS_FILE, RULE_LISTS, SETTINGS_FILES, splitRule, validateRule, type RuleList, type SettingsFile } from "./paseoPermissionsLogic";

const LIST_LABEL: Record<RuleList, string> = { allow: "Allow", deny: "Deny", ask: "Ask" };

/** Lists the project's saved permission rules from .claude/settings(.local).json, with confirmed removal. */
export function AllowRulesModal({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [files, setFiles] = useState<RuleFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); // `${path}|${list}|${rule}`
  const [busy, setBusy] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [newList, setNewList] = useState<RuleList>("allow");
  const [target, setTarget] = useState<SettingsFile>(DEFAULT_SETTINGS_FILE);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const ruleError = newRule.trim() ? validateRule(newRule, newList) : null;

  const reload = useCallback(async (dir: string) => {
    try {
      const f = await loadRuleFiles(dir);
      if (mounted.current) setFiles(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let live = true;
    agentCwd(agentId)
      .then((d) => {
        if (!live) return;
        setCwd(d);
        void reload(d);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [agentId, reload]);

  const run = async (fn: () => Promise<void>) => {
    if (!cwd) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (!mounted.current) return;
      setConfirm(null);
      await reload(cwd);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal allow-rules-modal" data-testid="allow-rules-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px" }}>Allow rules</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Saved in this project's <code>.claude</code> settings. Removing a rule means Claude asks again next time.
        </div>
        {error && (
          <div role="alert" data-testid="allow-rules-error" style={{ color: "var(--pink-t)", fontSize: 12, marginBottom: 6 }}>
            {error}
          </div>
        )}
        <div style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
          {!files && !error && <div className="muted small">Loading…</div>}
          {files?.map((f) => {
            const total = RULE_LISTS.reduce((n, l) => n + f.rules[l].length, 0);
            return (
              <div key={f.path} data-testid="allow-rules-file" style={{ marginBottom: 10 }}>
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>{f.path}</div>
                {!f.exists && <div className="muted small">Not found.</div>}
                {f.error && <div className="muted small" style={{ color: "var(--pink-t)" }}>{f.error}</div>}
                {f.exists && !f.error && total === 0 && <div className="muted small">No permission rules.</div>}
                {RULE_LISTS.map((list) =>
                  f.rules[list].map((rule) => {
                    const key = `${f.path}|${list}|${rule}`;
                    const { tool, pattern } = splitRule(rule);
                    return (
                      <div
                        key={key}
                        data-testid="allow-rule-row"
                        style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "3px 0", borderBottom: "1px solid var(--line)" }}
                      >
                        <span className={`badge ${list === "allow" ? "ok" : list === "deny" ? "bad" : ""}`} style={{ fontSize: 9 }}>{LIST_LABEL[list]}</span>
                        <b style={{ fontSize: 12 }}>{tool}</b>
                        <span style={{ fontFamily: "monospace", fontSize: 11, flex: 1, minWidth: 80, overflowWrap: "anywhere" }}>{pattern}</span>
                        {confirm === key ? (
                          <>
                            <span className="small">Remove?</span>
                            <button
                              type="button"
                              className="btn bad small"
                              data-testid="allow-rule-confirm"
                              disabled={busy}
                              onClick={() => void run(() => removeSavedRule(cwd!, f.path, list, rule))}
                            >
                              Yes
                            </button>
                            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setConfirm(null)}>
                              No
                            </button>
                          </>
                        ) : (
                          <button type="button" className="btn ghost small" data-testid="allow-rule-remove" disabled={busy} onClick={() => setConfirm(key)}>
                            Remove
                          </button>
                        )}
                      </div>
                    );
                  }),
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <select value={newList} onChange={(e) => setNewList(e.target.value as RuleList)} style={{ width: "auto" }} aria-label="Rule type">
            {RULE_LISTS.map((l) => (
              <option key={l} value={l}>{LIST_LABEL[l]}</option>
            ))}
          </select>
          <input
            data-testid="allow-rule-new"
            style={{ flex: 1, minWidth: 140 }}
            placeholder="e.g. Bash(npm run test:*)"
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
          />
          <button
            type="button"
            className="btn small"
            data-testid="allow-rule-add"
            disabled={busy || !newRule.trim() || !cwd || !!ruleError}
            onClick={() => void run(async () => { await addSavedRule(cwd!, newList, newRule.trim(), target); setNewRule(""); })}
          >
            Add
          </button>
          <select value={target} onChange={(e) => setTarget(e.target.value as SettingsFile)} style={{ width: "auto" }} aria-label="Save to" data-testid="allow-rule-target">
            <option value={SETTINGS_FILES[0]}>Save to: local (private)</option>
            <option value={SETTINGS_FILES[1]}>Save to: settings.json (shared, committed)</option>
          </select>
        </div>
        {ruleError && <div className="small" data-testid="allow-rule-invalid" style={{ color: "var(--pink-t)", marginTop: 4 }}>{ruleError}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
