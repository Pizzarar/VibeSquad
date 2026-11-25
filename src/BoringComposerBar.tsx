import type { ReactNode } from "react";

/**
 * B16 (Normal mode only): the composer's bottom toolbar row. Left = attach / secure input / park in inbox, middle = the shared
 * useAgentConfig controls (provider, model, thinking, mode), right = Stop / Interrupt / Send. Purely presentational: Composer owns
 * the state and the shared hook (lifted into AgentDrawer) supplies the control nodes. Psycho keeps ComposerMore.
 */
export type BoringComposerBarProps = {
  providerSelect?: ReactNode;
  modelControl?: ReactNode;
  thinkingSelect?: ReactNode;
  modeSelect?: ReactNode;
  /** One-click "Switch to X" (shared hook) when the provider can be swapped. */
  providerSwitchBtn?: ReactNode;
  /** e.g. "Switching to Gemini on your next message" while a provider switch is staged. */
  stagedHint?: string | null;
  isBs: boolean;
  inboxParking: boolean;
  running: boolean;
  sendDisabled: boolean;
  interruptDisabled: boolean;
  interruptTitle: string;
  sendTitle?: string;
  onAttach: () => void;
  onSecret: () => void;
  onPark: () => void;
  onStop: () => void;
  onInterrupt: () => void;
  onSend: () => void;
};

export function BoringComposerBar(p: BoringComposerBarProps) {
  return (
    <div className="boring-composer-bar" data-testid="boring-composer-bar" role="toolbar" aria-label="Composer controls">
      <div className="boring-composer-actions">
        <button type="button" className="boring-composer-icon" data-testid="boring-composer-attach-btn" title="Attach file or image" aria-label="Attach file or image" onClick={p.onAttach}>
          <span aria-hidden="true">📎</span>
        </button>
        <button type="button" className="boring-composer-icon" data-testid="boring-composer-secret-btn" title="Insert sealed secret (written to 0600 temp file, never shown in chat)" aria-label="Secure Input" onClick={p.onSecret}>
          <span aria-hidden="true">🔒</span>
        </button>
        {p.isBs && (
          <button type="button" className="boring-composer-icon" data-testid="boring-composer-park-btn" title="Park draft into Idea Inbox (0 tokens)" aria-label="Park in Inbox" disabled={p.inboxParking} onClick={p.onPark}>
            <span aria-hidden="true">📥</span>
          </button>
        )}
      </div>
      <div className="boring-composer-cfg" data-testid="boring-composer-cfg" role="group" aria-label="Model and mode">
        {p.providerSelect}
        {p.modelControl}
        {p.thinkingSelect && <span className="boring-composer-field"><span className="boring-composer-field-label" aria-hidden="true">Think</span>{p.thinkingSelect}</span>}
        {p.modeSelect && <span className="boring-composer-field"><span className="boring-composer-field-label" aria-hidden="true">Mode</span>{p.modeSelect}</span>}
        {p.providerSwitchBtn}
      </div>
      {p.stagedHint && <div className="boring-composer-staged" data-testid="boring-composer-staged" role="status">{p.stagedHint}</div>}
      <div className="boring-composer-send">
        {p.running && (
          <button type="button" className="btn ghost composer-stop-btn" title="Stop the current turn (keeps the agent)" aria-label="Stop" data-testid="composer-stop-btn" onClick={p.onStop}>
            ■
          </button>
        )}
        {p.running && (
          <button type="button" className="btn warn composer-interrupt-btn" disabled={p.interruptDisabled} title={p.interruptTitle} data-testid="composer-interrupt-btn" onClick={p.onInterrupt}>
            <span className="emoji-glyph">⚡ </span>Interrupt &amp; send
          </button>
        )}
        <button type="button" className="btn boring-composer-send-btn" data-testid="boring-composer-send-btn" disabled={p.sendDisabled} title={p.sendTitle} onClick={p.onSend}>
          {p.running ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
