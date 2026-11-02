// Pinned teams step 3: the team brief editor (docs/PLAN_PINNED_FEATURES.md §3).
// Opens docs/brainstorm/<lane>.md, saves it through the existing summary endpoint, and steers the
// team's live Brainstorm (if any) to re-read it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { isImeComposing } from "./IdeaInbox";
import { sendMessage, usePaseo } from "./paseo";
import { briefDiffSummary, briefPathFor, briefShrinkWarning } from "./pins";
import { onOpenBriefEditor, type BriefTarget } from "./pinActions";
import { Modal } from "./TeamActions";
import { findCrossTeamBrainstorm, resolve } from "./teams";

const MAX_BRIEF_CHARS = 20_000;

type Props = BriefTarget & { onClose: () => void };

export function BriefEditor({ laneId, laneName, onClose }: Props) {
  const { agents } = usePaseo();
  const live = useMemo(() => findCrossTeamBrainstorm(resolve(agents), laneId), [agents, laneId]);
  const [original, setOriginal] = useState("");
  const [text, setText] = useState("");
  const [path, setPath] = useState(briefPathFor(laneId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = text !== original;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/__vibesquad/brainstorm-summary?lane=${encodeURIComponent(laneId)}`)
      .then((r) => r.json())
      .then((body: { ok?: boolean; content?: string; path?: string; error?: string }) => {
        if (cancelled) return;
        if (!body.ok) throw new Error(body.error ?? "Could not load the brief");
        setOriginal(String(body.content ?? ""));
        setText(String(body.content ?? ""));
        if (body.path) setPath(body.path);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [laneId]);

  // No scary clicks: closing with unsaved edits needs a second tap.
  const close = useCallback(() => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [dirty, confirmDiscard, onClose]);

  const save = async () => {
    if (saving || loading || !dirty) return;
    // Same guard as the server's brief writes (server/brief-write.mjs): explain it here instead of a bare 400.
    const shrink = briefShrinkWarning(original, text);
    if (shrink) {
      setError(shrink);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/__vibesquad/brainstorm-summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ laneId, content: text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      if (live) {
        const summary = briefDiffSummary(original, text);
        await sendMessage(live.agent.id, `Brief updated: ${summary}. Re-read ${path}.`);
      }
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const over = text.length >= MAX_BRIEF_CHARS;
  return (
    <Modal
      title={`Brief · ${laneName || laneId}`}
      onClose={close}
      wide
      footer={
        <>
          <span className={over ? "stat-alert" : "muted"}>
            {confirmDiscard
              ? "Unsaved changes. Close again to discard."
              : error
                ? error
                : live
                  ? "Saving tells the Brainstorm to re-read it."
                  : "The next Brainstorm starts from this."}
          </span>
          <button className="btn ghost" onClick={close}>
            {confirmDiscard ? "Discard" : "Cancel"}
          </button>
          <button className="btn ok" disabled={!dirty || saving || loading || over} onClick={() => void save()} data-testid="brief-save">
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="brief-editor">
        <div className="brief-editor-meta">
          <code>{path}</code>
          <span className={over ? "stat-alert" : "muted"}>
            {text.length.toLocaleString()} / {MAX_BRIEF_CHARS.toLocaleString()} chars
          </span>
        </div>
        {loading ? (
          <div className="muted">Loading brief…</div>
        ) : (
          <textarea
            className="brief-editor-text"
            data-testid="brief-editor-text"
            value={text}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setConfirmDiscard(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !isImeComposing(e)) {
                e.preventDefault();
                void save();
              }
            }}
          />
        )}
      </div>
    </Modal>
  );
}

/** Mount once near the app root. Renders the brief editor whenever openBriefEditor() is called. */
export function BriefEditorHost() {
  const [target, setTarget] = useState<BriefTarget | null>(null);
  useEffect(() => onOpenBriefEditor(setTarget), []);
  if (!target) return null;
  return <BriefEditor key={target.laneId} {...target} onClose={() => setTarget(null)} />;
}
