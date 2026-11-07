import { useEffect, useState } from "react";
import { DEMO } from "./demoFlag";
import { isImeComposing } from "./IdeaInbox";
import { MarkdownRenderer } from "./Timeline";
import { AllowRulesModal } from "./AllowRulesModal";
import { buildKeepPlanning, buildPlanApprove, orderPlanActions, planWasEdited, suggestionLabel, suggestionScope, type PlanAction } from "./paseoPermissionsLogic";

type PermissionCardProps = {
  p: any;
  agentId: string;
  agentName?: string;
  permInputs: Record<string, string>;
  setPermInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
};

export function respondToPermission(agentId: string, requestId: string, response: Record<string, unknown>): Promise<void> {
  if (DEMO) return Promise.resolve();
  // Runner agents never raise permission prompts (their approval policy is set at spawn), so there is nothing to answer.
  return Promise.reject(new Error(`no permission prompt to answer for ${agentId} (${requestId}, ${Object.keys(response).length} fields)`));
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

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

export function parseRecommendedOption(label: string): { cleanLabel: string; recommended: boolean } {
  const re = /\s*(?:\(Recommended\)|\[Recommended\]|-\s*Recommended)\s*/gi;
  if (re.test(label)) {
    const cleanLabel = label.replace(/\s*(?:\(Recommended\)|\[Recommended\]|-\s*Recommended)\s*/gi, "").trim();
    return { cleanLabel, recommended: true };
  }
  return { cleanLabel: label, recommended: false };
}

export function areAllQuestionsAnswered(
  questions: Array<{ question?: string; header?: string }>,
  selectedByQ: Record<number, string>,
  otherByQ: Record<number, string>,
): boolean {
  if (questions.length === 0) {
    return Boolean((otherByQ[0] ?? selectedByQ[0] ?? "").trim());
  }
  return questions.every((_, qi) => {
    const val = (selectedByQ[qi] === "__other__" ? otherByQ[qi] : selectedByQ[qi]) ?? "";
    return val.trim().length > 0;
  });
}

export function buildQuestionSubmission(
  inputObj: Record<string, unknown>,
  questions: Array<{ question?: string; header?: string }>,
  selectedByQ: Record<number, string>,
  otherByQ: Record<number, string>,
): { behavior: "allow"; updatedInput: Record<string, unknown> } {
  const answers: Record<string, string> = {};
  questions.forEach((q, qi) => {
    const key = q.question || q.header || `q${qi + 1}`;
    const val = ((selectedByQ[qi] === "__other__" ? otherByQ[qi] : selectedByQ[qi]) ?? "").trim();
    answers[key] = val;
  });

  let firstAnswer: string;
  if (questions.length === 0) {
    firstAnswer = ((selectedByQ[0] === "__other__" ? otherByQ[0] : selectedByQ[0]) ?? "").trim();
  } else {
    const firstKey = questions[0].question || questions[0].header || "q1";
    firstAnswer = answers[firstKey] ?? "";
  }

  return {
    behavior: "allow",
    updatedInput: {
      ...inputObj,
      answer: firstAnswer,
      answers: { ...((inputObj.answers as Record<string, string>) ?? {}), ...answers },
    },
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PermissionCard({ p, agentId, agentName, permInputs, setPermInputs }: PermissionCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [denyMsg, setDenyMsg] = useState("");
  const [selectedByQ, setSelectedByQ] = useState<Record<number, string>>({});
  const [otherByQ, setOtherByQ] = useState<Record<number, string>>({});
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [planEditing, setPlanEditing] = useState(false);
  const [planDraft, setPlanDraft] = useState<string | null>(null);

  // A card can stay mounted while the next request arrives: never carry a draft or feedback across requests.
  useEffect(() => {
    setPlanEditing(false);
    setPlanDraft(null);
    setDenyMsg("");
    setError(null);
    setSelectedByQ({});
    setOtherByQ({});
    setMoreMenuOpen(false);
  }, [p.id]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-perm-more]")) setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [moreMenuOpen]);

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
  const isMode = p.kind === "mode";
  const isToolPerm = !isQuestion && !isPlan;

  const commandPreview = isToolPerm ? extractCommandPreview(inputObj, detailObj) : null;
  const diffPreview = isToolPerm && !commandPreview ? extractDiffPreview(inputObj, detailObj) : null;
  const genericPreview =
    isToolPerm && !commandPreview && !diffPreview ? extractGenericPreview(inputObj) : null;

  const suggestions: any[] = Array.isArray(p.suggestions) ? p.suggestions : [];

  const allAnswered = areAllQuestionsAnswered(questions, selectedByQ, otherByQ);

  const handleDeny = () => {
    const msg = denyMsg.trim();
    void doRespond(p.id, msg ? { behavior: "deny", message: msg } : { behavior: "deny" });
  };

  const planActions = orderPlanActions(Array.isArray(p.actions) ? (p.actions as PlanAction[]) : []);
  const planApprovals = planActions.filter((a) => a.behavior === "allow");
  const planDenials = planActions.filter((a) => a.behavior !== "allow");
  const edited = planText !== undefined && planDraft !== null && planWasEdited(planText, planDraft);
  const approvePlan = (a?: PlanAction) =>
    void doRespond(p.id, buildPlanApprove(a, edited ? planDraft! : undefined, inputObj));
  const keepPlanning = () => void doRespond(p.id, buildKeepPlanning(denyMsg, planDenials[0]));

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {isQuestion ? (
              <b data-testid="perm-question-agent-title">{agentName || p.agentName || "Agent"}</b>
            ) : (
              <>
                <b>{p.title ?? p.name}</b>
                {isMode && <span className="chip" data-testid="perm-mode-chip" style={{ marginLeft: 6 }}>mode change</span>}
                {p.description && <div className="muted small">{p.description}</div>}
              </>
            )}
          </div>
          <div style={{ position: "relative" }} data-perm-more>
            <button
              type="button"
              className="btn ghost small"
              data-testid="perm-question-more-btn"
              aria-label="More"
              onClick={() => setMoreMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {moreMenuOpen && (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  background: "var(--bg, #1e1e1e)",
                  border: "1px solid var(--line)",
                  padding: 4,
                  zIndex: 100,
                  minWidth: 120,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {isQuestion && (
                  <button
                    type="button"
                    className="btn bad small"
                    data-testid="perm-question-deny-menu-item"
                    disabled={submitting}
                    onClick={() => { setMoreMenuOpen(false); handleDeny(); }}
                  >
                    Deny question
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="perm-allow-rules-menu-item"
                  onClick={() => { setMoreMenuOpen(false); setRulesOpen(true); }}
                >
                  Allow rules…
                </button>
              </div>
            )}
          </div>
        </div>
        {rulesOpen && <AllowRulesModal agentId={agentId} onClose={() => setRulesOpen(false)} />}

        {isPlan && planText && (
          planEditing ? (
            <textarea
              className="perm-plan-edit"
              data-testid="perm-plan-edit"
              aria-label="Edit plan"
              value={planDraft ?? planText}
              onChange={(e) => setPlanDraft(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", minHeight: 180, maxHeight: "50vh", margin: "6px 0", fontFamily: "monospace", fontSize: 12 }}
            />
          ) : (
            <div
              className="perm-plan-body"
              data-testid="perm-plan-body"
              style={{ maxHeight: "40vh", overflowY: "auto", margin: "6px 0", padding: 8, background: "var(--well)", border: "1px solid var(--line)", fontSize: 12 }}
            >
              <MarkdownRenderer text={edited ? planDraft! : planText} agentId={agentId} doc />
              {edited && <div className="muted small" data-testid="perm-plan-edited">edited, will be sent on approve</div>}
            </div>
          )
        )}

        {isQuestion && questions.length === 0 && (
          <input
            className="perm-text-input"
            type="text"
            placeholder="Your answer…"
            value={(selectedByQ[0] as string) ?? ""}
            onChange={(e) => setSelectedByQ((prev) => ({ ...prev, [0]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e) && allAnswered) {
                e.preventDefault();
                void doRespond(p.id, buildQuestionSubmission(inputObj, questions, selectedByQ, otherByQ));
              }
            }}
          />
        )}

        {isQuestion &&
          questions.map((q, qi) => (
            <div key={qi} className="perm-question-item" data-testid={`perm-question-item-${qi}`} style={{ marginTop: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                {q.header && (
                  <span className="chip perm-q-header-chip" data-testid={`perm-q-header-${qi}`}>
                    {q.header}
                  </span>
                )}
                {q.question && <span className="perm-q-text">{q.question}</span>}
              </div>
              {Array.isArray(q.options) && q.options.length > 0 && (
                <div
                  role="radiogroup"
                  className="perm-question-options"
                  style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}
                >
                  {q.options.map((opt, oi) => {
                    const { cleanLabel, recommended } = parseRecommendedOption(opt.label);
                    const isSelected = selectedByQ[qi] === opt.label;
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        data-testid={`perm-q-${qi}-opt-${oi}`}
                        aria-pressed={isSelected}
                        className={`btn small ${isSelected ? "ok on" : "ghost"}`}
                        onClick={() => setSelectedByQ((prev) => ({ ...prev, [qi]: opt.label }))}
                      >
                        {cleanLabel}
                        {recommended && (
                          <span
                            className="badge ok perm-rec-badge"
                            data-testid="perm-recommended-badge"
                            style={{ marginLeft: 6, fontSize: 9, textTransform: "none" }}
                          >
                            Recommended
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    data-testid={`perm-q-${qi}-other-btn`}
                    aria-pressed={selectedByQ[qi] === "__other__"}
                    className={`btn small ${selectedByQ[qi] === "__other__" ? "ok on" : "ghost"}`}
                    onClick={() => setSelectedByQ((prev) => ({ ...prev, [qi]: "__other__" }))}
                  >
                    Other…
                  </button>
                </div>
              )}
              {selectedByQ[qi] === "__other__" && (
                <input
                  type="text"
                  data-testid={`perm-q-${qi}-other-input`}
                  placeholder="Other…"
                  value={otherByQ[qi] ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setOtherByQ((prev) => ({ ...prev, [qi]: val }));
                    setSelectedByQ((prev) => ({ ...prev, [qi]: "__other__" }));
                  }}
                />
              )}
              {Array.isArray(q.options) && q.options.some((o) => o.description) && (
                <div className="perm-question-descriptions muted small">
                  {q.options.map((opt) => {
                    if (!opt.description) return null;
                    const { cleanLabel } = parseRecommendedOption(opt.label);
                    return (
                      <div key={opt.label}>
                        {cleanLabel}: {opt.description}
                      </div>
                    );
                  })}
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
              background: "var(--well)",
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
                  background: "var(--well)",
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
                      color: line.startsWith("+") ? "var(--mint-t)" : line.startsWith("-") ? "var(--pink-t)" : undefined,
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
              background: "var(--well)",
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
          style={{ color: "var(--pink-t)", padding: "4px 0", fontSize: 12 }}
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
          <button
            type="button"
            data-testid="perm-question-submit-btn"
            className="btn ok"
            disabled={submitting || !allAnswered}
            onClick={() => void doRespond(p.id, buildQuestionSubmission(inputObj, questions, selectedByQ, otherByQ))}
          >
            Submit
          </button>
        </div>
      ) : isPlan ? (
        <div className="perm-actions perm-plan" style={{ flexWrap: "wrap" }}>
          {planApprovals.length ? (
            planApprovals.map((a) => (
              <button
                key={a.id}
                data-testid="perm-plan-approve"
                className={`btn ${a.intent === "implement" || a.intent === "implement_resume" ? "ok" : "ghost"}`}
                disabled={submitting}
                onClick={() => approvePlan(a)}
              >
                {edited ? `${a.label} (edited)` : a.label}
              </button>
            ))
          ) : (
            <button className="btn ok" data-testid="perm-plan-approve" disabled={submitting} onClick={() => approvePlan()}>
              {edited ? "Approve (edited)" : "Approve"}
            </button>
          )}
          {planText !== undefined && (
            <button
              type="button"
              className="btn ghost"
              data-testid="perm-plan-edit-toggle"
              disabled={submitting}
              onClick={() => { setPlanDraft((d) => d ?? planText); setPlanEditing((v) => !v); }}
            >
              {planEditing ? "Done editing" : "Edit plan, then approve"}
            </button>
          )}
          <div style={{ display: "flex", gap: 6, flexBasis: "100%", flexWrap: "wrap" }}>
            <input
              className="perm-deny-msg"
              data-testid="perm-deny-msg-input"
              type="text"
              style={{ flex: 1, minWidth: 160 }}
              placeholder="Feedback: what should change in the plan?"
              value={denyMsg}
              onChange={(e) => setDenyMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e)) {
                  e.preventDefault();
                  keepPlanning();
                }
              }}
            />
            <button type="button" className="btn" data-testid="perm-plan-keep-planning" disabled={submitting} onClick={keepPlanning}>
              Keep planning
            </button>
            {!planDenials.length && (
              <button className="btn bad" data-testid="perm-deny-btn" disabled={submitting} onClick={handleDeny}>
                Reject
              </button>
            )}
          </div>
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
              data-scope={suggestionScope(s)}
              disabled={submitting}
              onClick={() => handleSuggestion(s)}
            >
              {suggestionLabel(s)}
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
