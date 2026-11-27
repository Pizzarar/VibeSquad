// Storybook in-app "How to use" walkthrough overlay (PLAN_STORYBOOK_V2 W4-guide).
import { useEffect, useRef } from "react";
import { GUIDE_FOOTER_NOTE, GUIDE_STEPS, GUIDE_SUBTITLE, GUIDE_TITLE, type GuideStep } from "./storybookGuide";
import "./StorybookGuide.css";

export function StorybookGuide({ open, onClose, onShowMe }: {
  open: boolean;
  onClose: () => void;
  onShowMe: (step: GuideStep) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="sb-guide-back"
      data-testid="sb-guide-back"
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
    >
      <div
        className="sb-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sb-guide-title"
        data-testid="sb-guide"
      >
        <div className="sb-guide-head">
          <div className="sb-guide-titles">
            <h3 id="sb-guide-title" className="sb-guide-title">{GUIDE_TITLE}</h3>
            <p className="sb-guide-sub">{GUIDE_SUBTITLE}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="sb-btn sb-guide-close"
            data-testid="sb-guide-close"
            aria-label="Close guide"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <ol className="sb-guide-list" data-testid="sb-guide-list">
          {GUIDE_STEPS.map((step, i) => (
            <li key={step.id} className="sb-guide-step" data-testid={`sb-guide-step-${step.id}`}>
              <span className="sb-guide-num" aria-hidden="true">{i + 1}</span>
              <div className="sb-guide-copy">
                <div className="sb-guide-step-title">{step.title}</div>
                <p className="sb-guide-step-body">{step.body}</p>
              </div>
              <button
                type="button"
                className="sb-btn sb-guide-go"
                data-testid={`sb-guide-go-${step.id}`}
                onClick={() => onShowMe(step)}
              >
                {step.cta}
              </button>
            </li>
          ))}
        </ol>
        <div className="sb-guide-foot">
          <span className="sb-guide-note">{GUIDE_FOOTER_NOTE}</span>
          <button
            type="button"
            className="sb-btn sb-guide-done"
            data-testid="sb-guide-done"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
