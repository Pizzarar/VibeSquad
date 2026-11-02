import { useEffect, useMemo, useState } from "react";
import { KEY_COMMANDS, comboFromEvent, findConflicts, resetBinding, setBinding } from "./keymap";
import { setKeyOverrides, useKeyBindings } from "./prefs";

// Settings › Keybindings: rebind any keymap command, see conflicts, reset one or all. Overrides live in
// prefs "keys.bindings" (so they export/import with the other app settings).

type Recording = { id: string; replace: boolean } | null;

export function KeybindingsEditor() {
  const { overrides, bindings } = useKeyBindings();
  const [rec, setRec] = useState<Recording>(null);
  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);

  // Capture phase on window: the recorded key never reaches the keymap dispatcher or the Modal's Esc.
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return setRec(null);
      const combo = comboFromEvent(e);
      if (!combo) return; // lone modifier: keep waiting for the key
      const cur = bindings.get(rec.id) ?? [];
      setKeyOverrides(setBinding(overrides, rec.id, rec.replace ? [combo] : [...cur, combo]));
      setRec(null);
    };
    const cancel = () => setRec(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [rec, overrides, bindings]);

  const anyOverride = Object.keys(overrides).length > 0;
  return (
    <div data-testid="keybindings-editor">
      <p className="settings-note">
        Click <b>Change</b> and press the new keys (Esc cancels). <b>+</b> adds a second shortcut. The <kbd>?</kbd> cheat sheet shows what is bound now.
        <button
          className="btn ghost small"
          data-testid="keybindings-reset-all"
          disabled={!anyOverride}
          style={{ marginLeft: 8 }}
          onClick={() => {
            if (window.confirm("Reset all keybindings to their defaults?")) setKeyOverrides({});
          }}
        >
          Reset all
        </button>
      </p>
      {KEY_COMMANDS.map((c) => {
        const combos = bindings.get(c.id) ?? [];
        const recording = rec?.id === c.id;
        const clash = conflicts.get(c.id) ?? [];
        return (
          <div key={c.id} className="settings-row" data-testid={`keybinding-row-${c.id}`}>
            <div className="settings-row-text">
              <div className="settings-row-label">{c.label}</div>
              {c.id in overrides && <div className="muted small">Default: {c.defaults.join(" / ") || "none"}</div>}
              {clash.map((x) => (
                <div key={x.combo + x.with} className="dup-warning small" role="alert" data-testid="keybinding-conflict">
                  {x.combo} is also {x.with.startsWith("reserved") ? x.with : `bound to ${x.with}`}
                </div>
              ))}
            </div>
            <div className="settings-row-control keybinding-control">
              {recording ? (
                <span className="keybinding-recording" data-testid="keybinding-recording">
                  Press keys… (Esc cancels)
                </span>
              ) : combos.length ? (
                combos.map((k) => (
                  <span key={k} className="keybinding-chip">
                    <kbd>{k}</kbd>
                    <button className="keybinding-remove" title={`Remove ${k}`} aria-label={`Remove ${k}`} onClick={() => setKeyOverrides(setBinding(overrides, c.id, combos.filter((x) => x !== k)))}>
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <span className="muted small">unbound</span>
              )}
              <button className="btn ghost small" data-testid={`keybinding-change-${c.id}`} onClick={() => setRec(recording ? null : { id: c.id, replace: true })}>
                {recording ? "Cancel" : "Change"}
              </button>
              {!recording && combos.length > 0 && combos.length < 4 && (
                <button className="btn ghost small" data-testid={`keybinding-add-${c.id}`} title="Add another shortcut" onClick={() => setRec({ id: c.id, replace: false })}>
                  +
                </button>
              )}
              <button
                className="btn ghost small"
                data-testid={`keybinding-reset-${c.id}`}
                disabled={!(c.id in overrides)}
                title={`Reset to default (${c.defaults.join(" / ") || "none"})`}
                onClick={() => setKeyOverrides(resetBinding(overrides, c.id))}
              >
                ↺
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
