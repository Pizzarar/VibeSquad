import { useState } from "react";
import { client, DEMO } from "./paseo";
import { isImeComposing } from "./IdeaInbox";

type PermissionCardProps = {
  p: any;
  agentId: string;
  permInputs: Record<string, string>;
  setPermInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
};

function respondToPermission(agentId: string, requestId: string, response: Record<string, unknown>): Promise<void> {
  if (DEMO) return Promise.resolve();
  return client.agents.ref(agentId).respondToPermission({ requestId, response: response as any });
}

function extractCommandPreview(input: Record<string, unknown>, detail?: Record<string, unknown>): string | null {
  const cmd =
    (input.command as string | undefined) ??
    (input.cmd as string | undefined) ??
    (detail?.command as string | undefined);
  if (!cmd) return null;
  const parts: string[] = [cmd];
  if (input.cwd) parts.push(`# cwd: ${input.cwd}`);
  if (input.description) parts.push(`# ${input.description}`);
  return parts.join("\n");
}

function extractDiffPreview(input: Record<string, unknown>, detail?: Record<string, unknown>): { filePath?: string; content: string } | null {
  const filePath =
    (input.file_path as string | undefined) ??
    (input.filePath as string | undefined) ??
    (input.path as string | undefined);

  const unifiedDiff =
    (input.unifiedDiff as string | undefined) ??
    (detail?.unifiedDiff as string | undefined);

  if (unifiedDiff) return { filePath, content: unifiedDiff };

  if (typeof input.old_string === "string" || typeof input.new_string === "string") {
    const lines: string[] = [];
    if (filePath) lines.push(`--- ${filePath}`, `+++ ${filePath}`);
    if (typeof input.old_string === "string") {
      for (const l of (input.old_string as string).split("\n")) lines.push(`-${l}`);
    }
    if (typeof input.new_string === "string") {
      for (const l of (input.new_string as string).split("\n")) lines.push(`+${l}`);
    }
    return { filePath, content: lines.join("\n") };
  }

  if (typeof input.content === "string") {
    return { filePath, content: input.content };
  }

  if (filePath) {
    return { filePath, content: "" };
  }

  return null;
}

function extractGenericPreview(input: Record<string, unknown>): string | null {
  const SKIP = new Set(["questions", "plan", "answers", "answer"]);
  const keys = Object.keys(input).filter((k) => !SKIP.has(k));
  if (!keys.length) return null;
  const pairs = keys.map((k) => {
    const v = input[k];
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}: ${s.length > 200 ? s.slice(0, 200) + "…" : s}`;
  });
  return pairs.join("\n");
}

export function PermissionCard({ p, agentId, permInputs, setPermInputs }: PermissionCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [denyMsg, setDenyMsg] = useState("");

  const doRespond = async (requestId: string, response: Record<string, unknown>) => {
    setSubmitting(true);
    setError(null);
    try {
      await respondToPermission(agentId, requestId, response);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const inputObj = (p.input ?? {}) as Record<string, unknown>;
  const detailObj = (p.detail ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(inputObj.questions)
    ? (inputObj.questions as Array<{
        question?: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
      }>)
    : [];
  const planText = typeof inputObj.plan === "string" ? inputObj.plan : undefined;

  const isQuestion = p.kind === "question";
  const isPlan = p.kind === "plan";
  const isToolPerm = !isQuestion && !isPlan;

  const commandPreview = isToolPerm ? extractCommandPreview(inputObj, detailObj) : null;
  const diffPreview = isToolPerm && !commandPreview ? extractDiffPreview(inputObj, detailObj) : null;
  const genericPreview =
    isToolPerm && !commandPreview && !diffPreview ? extractGenericPreview(inputObj) : null;

  const suggestions: any[] = Array.isArray(p.suggestions) ? p.suggestions : [];

  const submitQuestionAnswer = (ans: string, qText?: string) => {
    const firstQ = qText ?? questions[0]?.question;
    const updatedInput: Record<string, unknown> = {
      ...inputObj,
      answer: ans,
      ...(firstQ ? { answers: { ...((inputObj.answers as Record<string, string>) ?? {}), [firstQ]: ans } } : {}),
    };
    void doRespond(p.id, { behavior: "allow", updatedInput });
  };

  const handleDeny = () => {
    const msg = denyMsg.trim();
    void doRespond(p.id, msg ? { behavior: "deny", message: msg } : { behavior: "deny" });
  };

  const handleSuggestion = (suggestion: any) => {
    void doRespond(p.id, { behavior: "allow", updatedPermissions: [suggestion] });
  };

  const handleAllowSession = () => {
    const toolName = p.name ?? p.title;
    const updatedPermissions = suggestions.length > 0
      ? suggestions
      : [{ type: "tool", tool: toolName, behavior: "allow" }];
    void doRespond(p.id, { behavior: "allow", updatedPermissions });
  };

  return (
    <div className="perm NeedsYouHighlight" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div>
        <b>{p.title ?? p.name}</b>
        {p.description && <div className="muted small">{p.description}</div>}

        {isPlan && planText && (
          <pre
            className="perm-plan-body"
            style={{
              maxHeight: 180,
              overflowY: "auto",
              margin: "6px 0",
              padding: 8,
              background: "#090a16",
              border: "1px solid var(--line)",
              whiteSpace: "pre-wrap",
              fontSize: 11,
            }}
          >
            {planText}
          </pre>
        )}

        {isQuestion &&
          questions.map((q, qi) => (
            <div key={qi} className="perm-question-item" style={{ marginTop: 6 }}>
              {q.question && <div className="small" style={{ marginBottom: 4 }}>{q.question}</div>}
              {Array.isArray(q.options) && q.options.length > 0 && (
                <div className="perm-question-options" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
                  {q.options.map((opt) => (
                    <button
                      key={opt.label}
                      className="btn ok small"
                      title={opt.description}
                      onClick={() => submitQuestionAnswer(opt.label, q.question)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

        {commandPreview && (
          <pre
            className="perm-preview-cmd"
            data-testid="perm-preview-cmd"
            style={{
              margin: "6px 0",
              padding: 8,
              background: "#090a16",
              border: "1px solid var(--line)",
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
              fontSize: 11,
              overflowX: "auto",
            }}
          >
            {commandPreview}
          </pre>
        )}

        {diffPreview && (
          <div style={{ margin: "6px 0" }}>
            {diffPreview.filePath && (
              <div className="small muted" style={{ fontFamily: "monospace", marginBottom: 2 }}>
                {diffPreview.filePath}
              </div>
            )}
            {diffPreview.content && (
              <pre
                className="perm-preview-diff"
                data-testid="perm-preview-diff"
                style={{
                  padding: 8,
                  background: "#090a16",
                  border: "1px solid var(--line)",
                  whiteSpace: "pre-wrap",
                  fontFamily: "monospace",
                  fontSize: 11,
                  overflowX: "auto",
                  margin: 0,
                }}
              >
                {diffPreview.content.split("\n").map((line, i) => (
                  <span
                    key={i}
                    style={{
                      display: "block",
                      color: line.startsWith("+") ? "#4caf50" : line.startsWith("-") ? "#f44336" : undefined,
                    }}
                  >
                    {line}
                  </span>
                ))}
              </pre>
            )}
          </div>
        )}

        {genericPreview && (
          <pre
            className="perm-preview-input"
            data-testid="perm-preview-input"
            style={{
              margin: "6px 0",
              padding: 8,
              background: "#090a16",
              border: "1px solid var(--line)",
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
              fontSize: 11,
              overflowX: "auto",
            }}
          >
            {genericPreview}
          </pre>
        )}
      </div>

      {error && (
        <div
          className="perm-error"
          role="alert"
          data-testid="perm-error"
          style={{ color: "#f44336", padding: "4px 0", fontSize: 12 }}
        >
          {error}
          <button
            className="btn ghost small"
            style={{ marginLeft: 8 }}
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {isQuestion ? (
        <div className="perm-actions perm-question" style={{ flexWrap: "wrap" }}>
          {p.actions?.map((a: any) => (
            <button
              key={a.id}
              className={`btn ${a.variant === "danger" ? "bad" : a.behavior === "deny" ? "bad" : "ok"}`}
              disabled={submitting}
              onClick={() => void doRespond(p.id, { behavior: a.behavior === "allow" ? "allow" : "deny", selectedActionId: a.id })}
            >
              {a.label}
            </button>
          ))}
          <input
            className="perm-text-input"
            type="text"
            placeholder="Your answer…"
            value={permInputs[p.id] ?? ""}
            onChange={(e) => setPermInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                submitQuestionAnswer(permInputs[p.id] ?? "");
              }
            }}
          />
          <button className="btn ok" disabled={submitting} onClick={() => submitQuestionAnswer(permInputs[p.id] ?? "")}>
            Submit
          </button>
          <button className="btn bad" data-testid="perm-deny-btn" disabled={submitting} onClick={handleDeny}>
            Deny
          </button>
          <input
            className="perm-deny-msg"
            data-testid="perm-deny-msg-input"
            type="text"
            placeholder="Tell the agent what to do instead (optional)…"
            value={denyMsg}
            onChange={(e) => setDenyMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                handleDeny();
              }
            }}
          />
        </div>
      ) : isPlan ? (
        <div className="perm-actions perm-plan" style={{ flexWrap: "wrap" }}>
          {p.actions?.length ? (
            p.actions.map((a: any) => (
              <button
                key={a.id}
                className={`btn ${a.variant === "danger" ? "bad" : a.intent === "implement" || a.intent === "implement_resume" ? "ok" : "ghost"}`}
                disabled={submitting}
                onClick={() => void doRespond(p.id, { behavior: a.behavior === "allow" ? "allow" : "deny", selectedActionId: a.id })}
              >
                {a.label}
              </button>
            ))
          ) : (
            <button className="btn ok" disabled={submitting} onClick={() => void doRespond(p.id, { behavior: "allow" })}>
              Approve
            </button>
          )}
          <button className="btn bad" data-testid="perm-deny-btn" disabled={submitting} onClick={handleDeny}>
            Deny
          </button>
          <input
            className="perm-deny-msg"
            data-testid="perm-deny-msg-input"
            type="text"
            placeholder="Tell the agent what to do instead (optional)…"
            value={denyMsg}
            onChange={(e) => setDenyMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                handleDeny();
              }
            }}
          />
        </div>
      ) : (
        <div className="perm-actions" style={{ flexWrap: "wrap" }}>
          {p.actions?.map((a: any) => (
            <button
              key={a.id}
              className={`btn ${a.variant === "danger" ? "bad" : a.behavior === "deny" ? "bad" : "ok"}`}
              disabled={submitting}
              onClick={() => void doRespond(p.id, { behavior: a.behavior === "allow" ? "allow" : "deny", selectedActionId: a.id })}
            >
              {a.label}
            </button>
          ))}
          {!p.actions?.length && (
            <button className="btn ok" disabled={submitting} onClick={() => void doRespond(p.id, { behavior: "allow" })}>
              Allow
            </button>
          )}
          {suggestions.map((s: any, i: number) => (
            <button
              key={i}
              className="btn ok"
              data-testid="perm-allow-suggestion"
              disabled={submitting}
              onClick={() => handleSuggestion(s)}
            >
              {s.label ?? s.description ?? "Allow always"}
            </button>
          ))}
          {(p.name ?? p.title) && (
            <button
              className="btn ghost"
              data-testid="perm-allow-session"
              disabled={submitting}
              onClick={handleAllowSession}
            >
              Allow for session
            </button>
          )}
          <button className="btn bad" data-testid="perm-deny-btn" disabled={submitting} onClick={handleDeny}>
            Deny
          </button>
          <input
            className="perm-deny-msg"
            data-testid="perm-deny-msg-input"
            type="text"
            placeholder="Tell the agent what to do instead (optional)…"
            value={denyMsg}
            onChange={(e) => setDenyMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                e.preventDefault();
                handleDeny();
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
