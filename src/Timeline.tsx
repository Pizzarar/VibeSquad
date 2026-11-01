import { useEffect, useRef, useState } from "react";
import { client, DEMO } from "./paseo";
import { demoTimeline } from "./demo";
import { sentImagesFor } from "./imageDrafts";

export type Entry = { item: any; timestamp?: string; seqStart?: number };

const MD_IMAGE = /!\[([^\]]*)\]\(((?:file:\/\/|[A-Za-z]:[\\/])[^)\s]+)\)/g;

export function localImageSrc(u: string, agentId?: string): string {
  const base = `/__vibesquad/local-image?path=${encodeURIComponent(u)}`;
  return agentId ? `${base}&agentId=${encodeURIComponent(agentId)}` : base;
}

function AssistantText({ text, agentId }: { text: string; agentId?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const parts: Array<string | { alt: string; src: string }> = [];
  let last = 0;
  for (const m of text.matchAll(MD_IMAGE)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ alt: m[1] || "image", src: localImageSrc(m[2], agentId) });
    last = m.index! + m[0].length;
  }
  if (!parts.length) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  const imgs = parts.filter((p): p is { alt: string; src: string } => typeof p !== "string");
  const rest = parts.filter((p): p is string => typeof p === "string").join("").trim();
  return (
    <>
      <div className="tl-images">
        {imgs.map((im, i) => (
          <img key={i} src={im.src} alt={im.alt} className="tl-thumb" onClick={() => setOpen(im.src)} />
        ))}
      </div>
      {rest}
      {open && (
        <div className="img-lightbox" onClick={() => setOpen(null)}>
          <img src={open} alt="full size" />
        </div>
      )}
    </>
  );
}

export function TimelineItem({ e, agentId, onParkText }: { e: Entry; agentId: string; onParkText?: (text: string) => void }) {
  const it = e.item;
  if (!it || typeof it !== "object") return null;
  switch (it.type) {
    case "user_message": {
      const urls: string[] = it.images?.length
        ? it.images.map((im: any) => (im.data ? `data:${im.mimeType ?? "image/png"};base64,${im.data}` : im.url)).filter(Boolean)
        : sentImagesFor(agentId, it.text);
      return (
        <div className="tl tl-user">
          {urls.length > 0 && (
            <div className="tl-images">
              {urls.map((u, i) => (
                <img key={i} src={u} alt="sent attachment" />
              ))}
            </div>
          )}
          {it.text}
          {onParkText && typeof it.text === "string" && it.text.trim() && (
            <button
              className="tl-park-btn"
              title="Park message lines in Idea Inbox (0 tokens)"
              onClick={() => onParkText(it.text)}
            >
              📥 Park in Inbox
            </button>
          )}
        </div>
      );
    }
    case "assistant_message":
      return (
        <div className="tl tl-assistant">
          {typeof it.text === "string" ? <AssistantText text={it.text} agentId={agentId} /> : it.text}
          {onParkText && typeof it.text === "string" && it.text.trim() && (
            <button
              className="tl-park-btn"
              title="Park message lines in Idea Inbox (0 tokens)"
              onClick={() => onParkText(it.text)}
            >
              📥 Park in Inbox
            </button>
          )}
        </div>
      );
    case "reasoning":
      return null;
    case "tool_call": {
      const d = it.detail ?? {};
      if (d.type === "sub_agent")
        return (
          <div className={`tl tl-sub ${it.status}`}>
            <b>◈ sub-agent</b> {d.subAgentType ? `[${d.subAgentType}] ` : ""}
            {d.description ?? ""} <span className="muted">· {it.status}</span>
          </div>
        );
      const summary =
        d.type === "shell" ? d.command : d.filePath ?? d.query ?? d.url ?? d.label ?? d.text ?? "";
      return (
        <div className={`tl tl-tool ${it.status}`}>
          <span className="tool-name">{it.name}</span> <span className="muted">{String(summary).slice(0, 160)}</span>
        </div>
      );
    }
    case "todo":
      return (
        <div className="tl tl-todo">
          {(Array.isArray(it.items) ? it.items : []).map((t: any, i: number) => (
            <div key={i}>
              {t.completed || t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.text}
            </div>
          ))}
        </div>
      );
    case "error":
      return <div className="tl tl-error">{it.message}</div>;
    case "notification":
      return <div className={`tl tl-note ${it.level}`}>{it.message}</div>;
    default:
      return null;
  }
}

// A hidden tab (active=false) stays mounted but ignores live events; it refetches once on return.
export function useTimeline(agentId: string, status: string, active = true) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const stale = useRef(false);
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    if (DEMO) {
      setEntries(demoTimeline(agentId) as Entry[]);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = client.agents.ref(agentId);

    const load = async () => {
      try {
        const t = await handle.timeline.refetch({ direction: "tail", limit: 60, projection: "projected" });
        if (!alive) return;
        if (t.error) setError(String(t.error));
        else {
          setError(null);
          setEntries(t.entries as Entry[]);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    // Live events stream in token-by-token; refetching the projected tail on a short
    // debounce is simpler than merging deltas ourselves and is plenty for a dashboard.
    const soon = () => {
      if (!activeRef.current) {
        stale.current = true;
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, 600);
    };

    reload.current = load;
    load();
    const sub = handle.timeline.subscribe(() => soon());
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (typeof sub === "function") sub();
      else if (sub && typeof (sub as any).unsubscribe === "function") (sub as any).unsubscribe();
    };
  }, [agentId]);

  // Status flips (running -> idle) can land without a timeline event; reload then too.
  useEffect(() => {
    if (DEMO) return;
    if (!activeRef.current) {
      stale.current = true;
      return;
    }
    let alive = true;
    client.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 60, projection: "projected" })
      .then((t) => {
        if (!alive) return;
        if (!t.error) setEntries(t.entries as Entry[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId, status]);

  useEffect(() => {
    if (active && stale.current) {
      stale.current = false;
      reload.current();
    }
  }, [active]);

  return { entries, error };
}

type TimelineProps = {
  agentId: string;
  entries: Entry[];
  error: string | null;
  onParkText?: (text: string) => void;
};

export function Timeline({ agentId, entries, error, onParkText }: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = timelineRef.current;
    if (el && pinned.current && el.offsetParent) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div
      className="timeline"
      ref={timelineRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {error && <div className="tl tl-error">{error}</div>}
      {entries.map((e, i) => (
        <TimelineItem key={e.seqStart ?? i} e={e} agentId={agentId} onParkText={onParkText} />
      ))}
      <div />
    </div>
  );
}
