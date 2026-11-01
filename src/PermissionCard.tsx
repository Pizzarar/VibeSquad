import { client } from "./paseo";
import { isImeComposing } from "./IdeaInbox";

type PermissionCardProps = {
  p: any;
  agentId: string;
  permInputs: Record<string, string>;
  setPermInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
};

export function PermissionCard({ p, agentId, permInputs, setPermInputs }: PermissionCardProps) {
  const respond = (
    requestId: string,
    allow: boolean,
    extra?: { selectedActionId?: string; updatedInput?: Record<string, unknown> },
  ) =>
    client.agents
      .ref(agentId)
      .respondToPermission({ requestId, response: allow ? { behavior: "allow", ...extra } : { behavior: "deny" } })
      .catch((e: unknown) => alert(`Permission reply failed: ${e}`));

  const inputObj = (p.input ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(inputObj.questions)
    ? (inputObj.questions as Array<{
        question?: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
      }>)
    : [];
  const planText = typeof inputObj.plan === "string" ? inputObj.plan : undefined;

  const submitQuestionAnswer = (ans: string, qText?: string) => {
    const firstQ = qText ?? questions[0]?.question;
    const updatedInput: Record<string, unknown> = {
      ...inputObj,
      answer: ans,
      ...(firstQ ? { answers: { ...((inputObj.answers as Record<string, string>) ?? {}), [firstQ]: ans } } : {}),
    };
    void respond(p.id, true, { updatedInput });
  };

  return (
    <div className="perm NeedsYouHighlight" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div>
        <b>{p.title ?? p.name}</b>
        {p.description && <div className="muted small">{p.description}</div>}
        {p.kind === "plan" && planText && (
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
        {p.kind === "question" &&
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
      </div>
      {p.kind === "question" ? (
        <div className="perm-actions perm-question" style={{ flexWrap: "wrap" }}>
          {p.actions?.map((a: any) => (
            <button
              key={a.id}
              className={`btn ${a.variant === "danger" ? "bad" : a.behavior === "deny" ? "bad" : "ok"}`}
              onClick={() => respond(p.id, a.behavior === "allow", { selectedActionId: a.id })}
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
          <button className="btn ok" onClick={() => submitQuestionAnswer(permInputs[p.id] ?? "")}>
            Submit
          </button>
          <button className="btn bad" onClick={() => void respond(p.id, false)}>
            Deny
          </button>
        </div>
      ) : p.kind === "plan" ? (
        <div className="perm-actions perm-plan" style={{ flexWrap: "wrap" }}>
          {p.actions?.length ? (
            p.actions.map((a: any) => (
              <button
                key={a.id}
                className={`btn ${a.variant === "danger" ? "bad" : a.intent === "implement" || a.intent === "implement_resume" ? "ok" : "ghost"}`}
                onClick={() => void respond(p.id, a.behavior === "allow", { selectedActionId: a.id })}
              >
                {a.label}
              </button>
            ))
          ) : (
            <button className="btn ok" onClick={() => void respond(p.id, true)}>
              Approve
            </button>
          )}
          <button className="btn bad" onClick={() => void respond(p.id, false)}>
            Deny
          </button>
        </div>
      ) : (
        <div className="perm-actions" style={{ flexWrap: "wrap" }}>
          {p.actions?.map((a: any) => (
            <button
              key={a.id}
              className={`btn ${a.variant === "danger" ? "bad" : a.behavior === "deny" ? "bad" : "ok"}`}
              onClick={() => void respond(p.id, a.behavior === "allow", { selectedActionId: a.id })}
            >
              {a.label}
            </button>
          ))}
          {!p.actions?.length && (
            <>
              <button className="btn ok" onClick={() => void respond(p.id, true)}>
                Allow
              </button>
              <button className="btn bad" onClick={() => void respond(p.id, false)}>
                Deny
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
