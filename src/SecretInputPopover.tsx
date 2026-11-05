import { useEffect, useRef, useState } from "react";

export type SecretInputResult = {
  path: string;
  label?: string;
  expiresAt?: number | string;
};

export function formatSecretPromptToken(result: SecretInputResult): string {
  const rawLabel = typeof result?.label === "string" ? result.label.trim() : "";
  const safeLabel = rawLabel.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const filePath = String(result?.path ?? "").trim();
  return `[Secret${safeLabel ? ` (${safeLabel})` : ""} stored at ${filePath} — read from file, do not echo content]`;
}

export type SecretInputPopoverProps = {
  onInsert: (token: string) => void;
  onClose: () => void;
};

export function SecretInputPopover({ onInsert, onClose }: SecretInputPopoverProps) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secretRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    secretRef.current?.focus();
  }, []);

  const handleClose = () => {
    setValue("");
    setLabel("");
    setError(null);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitting) return;
    if (!value.trim()) {
      setError("Secret value is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/__vibesquad/secret-input", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || undefined,
          value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !data?.path) {
        throw new Error(data?.error ?? `Failed to store secret (${res.status})`);
      }
      const token = formatSecretPromptToken({
        path: data.path,
        label: data.label,
        expiresAt: data.expiresAt,
      });
      setValue("");
      setLabel("");
      onInsert(token);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="composer-menu secret-input-popover"
      data-testid="secret-input-popover"
      role="dialog"
      aria-label="Secure Input"
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        border: "1px solid var(--border, #444)",
        borderRadius: 6,
        padding: 10,
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>🔒 Secure Input</strong>
        <button
          type="button"
          className="btn ghost small"
          data-testid="secret-cancel-btn"
          aria-label="Close Secure Input"
          onClick={handleClose}
        >
          ✕
        </button>
      </div>
      <div className="muted small">
        Written to a 0600 local file in ~/.vibesquad/secrets/ (auto-deleted in 10m). Only the file path is inserted into your prompt.
      </div>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <input
          type="text"
          value={label}
          placeholder="Label (optional, e.g. API_KEY, DB_PASSWORD)"
          data-testid="secret-label-input"
          autoComplete="off"
          onChange={(e) => setLabel(e.target.value)}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            ref={secretRef}
            type={revealed ? "text" : "password"}
            value={value}
            placeholder="Paste secret value…"
            data-testid="secret-value-input"
            autoComplete="new-password"
            style={{ flex: 1 }}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
          />
          <button
            type="button"
            className="btn ghost small"
            data-testid="secret-visibility-toggle"
            title={revealed ? "Hide secret" : "Show secret"}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        </div>
        {error && (
          <div className="chip warn" data-testid="secret-input-error" role="alert">
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button type="button" className="btn ghost small" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn small"
            data-testid="secret-submit-btn"
            disabled={submitting || !value.trim()}
          >
            {submitting ? "Sealing…" : "Insert Sealed Path"}
          </button>
        </div>
      </form>
    </div>
  );
}
