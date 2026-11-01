import { useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { DraftImageView } from "./imageDrafts";
import { isImeComposing, shouldComposerSubmit } from "./IdeaInbox";

type ImgDraft = {
  images: DraftImageView[];
  add: (files: Array<File | Blob>) => void;
  remove: (id: string) => void;
  clear: () => void;
};

type ComposerProps = {
  agent: PaseoAgent;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  isBs: boolean;
  inboxParking: boolean;
  lastSteered: string | null;
  imgs: ImgDraft;
  onSend: () => void;
  onInterrupt: () => void;
  onParkToInbox: (text: string, fromComposer: boolean) => void;
  onToggleInboxPopover: () => void;
};

export function Composer({
  agent,
  draft,
  setDraft,
  busy,
  isBs,
  inboxParking,
  lastSteered,
  imgs,
  onSend,
  onInterrupt,
  onParkToInbox,
  onToggleInboxPopover,
}: ComposerProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      imgs.add(files);
    }
  };

  return (
    <footer
      className={`composer ${dragOver ? "drag-over composer-drop-active" : ""}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        imgs.add(Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/")));
      }}
    >
      {imgs.images.length > 0 && (
        <div className="composer-images composer-thumbs">
          {imgs.images.map((im) => (
            <div key={im.id} className="composer-thumb" title={im.name}>
              <img src={im.url} alt={im.name} />
              <span className="thumb-name">{im.name}</span>
              <button
                className="thumb-x composer-thumb-remove"
                aria-label={`Remove ${im.name}`}
                onClick={() => imgs.remove(im.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {lastSteered && (
        <div className="chip steered-chip" data-testid="steered-chip">
          steered
        </div>
      )}
      <div className="composer-row">
        <textarea
          value={draft}
          placeholder={`Message ${agent.title ?? "agent"}… (Enter to send, Ctrl+Enter to interrupt)`}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !isImeComposing(e)) {
              e.preventDefault();
              onInterrupt();
              return;
            }
            if (shouldComposerSubmit(e)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            imgs.add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          className="btn ghost attach-img composer-attach composer-attach-btn"
          title="Attach image"
          onClick={() => fileInput.current?.click()}
        >
          📎
        </button>
        {isBs && (
          <button
            className="btn ghost composer-park-inbox-btn"
            disabled={inboxParking}
            title="Park composer draft (1 or multiple newline-separated ideas) straight into Idea Inbox (0 tokens)"
            onClick={() => (draft.trim() ? onParkToInbox(draft, true) : onToggleInboxPopover())}
            data-testid="composer-park-inbox-btn"
          >
            📥 Park in Inbox
          </button>
        )}
        <button className="btn" disabled={busy || (!draft.trim() && !imgs.images.length)} onClick={onSend}>
          Send
        </button>
        {agent.status === "running" && (
          <button
            className="btn warn composer-interrupt-btn"
            disabled={busy || (!draft.trim() && !imgs.images.length)}
            title="Interrupt current turn and send (Ctrl+Enter)"
            data-testid="composer-interrupt-btn"
            onClick={onInterrupt}
          >
            ⚡ Interrupt &amp; send
          </button>
        )}
      </div>
    </footer>
  );
}
