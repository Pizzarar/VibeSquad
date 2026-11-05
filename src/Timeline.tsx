import { Component, Fragment, type ReactNode, useCallback, useSyncExternalStore, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PaseoAgentTimelineEvent } from "@getpaseo/client";
import { messageCtxItems, openContextMenu, selectionWithin } from "./CommandPalette";
import { daemonClient, client, DEMO, retrySend } from "./paseo";
import { dismissPending, dropReconciled, getPending, pendingFor, reconciledIds, subscribePending } from "./pendingSend";
import { REWIND_MODES, buildRewindRequest, truncateAfter, type RewindMode } from "./sessionLifecycle";
import { demoTimeline } from "./demo";
import { sentImagesFor } from "./imageDrafts";
import { parseSentAttachments, repoPathFor } from "./attachments";
import { openRightDockTab } from "./RightDock";
import { listTimelinePrompts, searchTimeline, type TimelinePrompt } from "./paseoTimeline";
import { perfEndPainted, perfSendEvent } from "./perf";
import { TIMELINE_FILTERS, adjacentPrompt, entryIndexForSeq, filterEntries, matchesFilter, localPrompts, localSearch, mergeLiveItem, maxEntrySeq, syncNeeded, latestReasoningIndex, reasoningText, sortedHits, stepIndex, type SearchLocation, type TimelineFilter } from "./timelineFilter";
import { BARE_PATH_RE, parseFileToken } from "./fileLinks";
import { toolStartsExpanded, usePref } from "./prefs";
import { getPanes } from "./panes";
import { SubagentList } from "./SubagentList";
import { Spinner, Stamp, TimelineSkeleton, useDelayedBusy } from "./QuickWinsUi";
import { MermaidView } from "./MermaidView";
import { noteTimelineOffers, useLooksDoneId } from "./PinGrid";
import { SpinOffCard, SendToCard, findPinForAgent, useSendTo, useSpinOff } from "./PinIdeas";
import { LooksDoneCard } from "./PinDone";
import { hasLooksDone, isHubPin, parseSendTo, parseSpinOff } from "./pins";

export class TimelineErrorBoundary extends Component<
  { children: ReactNode; fallbackLabel?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="tl tl-error" data-testid="tl-error-boundary">
          <b>Render error{this.props.fallbackLabel ? ` (${this.props.fallbackLabel})` : ""}:</b>{" "}
          {this.state.error.message}
          <button
            type="button"
            className="btn ghost"
            style={{ marginLeft: 8, padding: "1px 6px", fontSize: 10 }}
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export type Entry = { item: any; timestamp?: string; seqStart?: number };

const MD_IMAGE = /!\[([^\]]*)\]\(((?:file:\/\/|[A-Za-z]:[\\/])[^)\s]+)\)/g;
const FILE_LINK_RE = /(?<![`"'\w@.\/\x5c:#~-])([a-zA-Z0-9_.\-\/\x5c]+\.[a-zA-Z]{1,6})(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L?\d+)?)(?![a-zA-Z0-9_])/g;

export function localImageSrc(u: string, agentId?: string): string {
  const base = `/__vibesquad/local-image?path=${encodeURIComponent(u)}`;
  return agentId ? `${base}&agentId=${encodeURIComponent(agentId)}` : base;
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

export function formatToolError(err: any): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err.content === "string") return err.content;
  if (Array.isArray(err.content)) {
    return err.content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  if (typeof err.message === "string") return err.message;
  if (typeof err.text === "string") return err.text;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isFailedTool(it: any, d: any): boolean {
  return it.status === "failed" || it.status === "error" || !!it.error || (d.exitCode != null && d.exitCode !== 0);
}

/**
 * Strip a provider-switch boot preamble off a user message so the timeline shows only the user's actual words.
 * The server embeds "Pending message from the user to answer now:\n"; the seamless-switch flow embeds
 * "User message to answer now:\n". Either way, only the text after the last such marker is the real message.
 */
export function stripBootPreamble(text: string): string {
  if (typeof text !== "string") return text;
  const userMarker = "User message to answer now:\n";
  const pendingMarker = "Pending message from the user to answer now:\n";
  if (text.includes(userMarker)) {
    return text.slice(text.lastIndexOf(userMarker) + userMarker.length);
  }
  if (text.includes(pendingMarker)) {
    return text.slice(text.lastIndexOf(pendingMarker) + pendingMarker.length);
  }
  return text;
}

export function isSubAgentTool(it: any, d: any): boolean {
  return d.type === "sub_agent" || it.name === "Task" || !!(d.subAgentId || d.agentId || it.subagentId);
}

export function isCompaction(it: any): boolean {
  return it.type === "compaction" || it.type === "compacted" || it.type === "context_compaction";
}

export function isReasoning(it: any): boolean {
  return it.type === "reasoning";
}

export function extractFileLinks(text: string): Array<{ filePath: string; line: number | null }> {
  const results: Array<{ filePath: string; line: number | null }> = [];
  const re = new RegExp(FILE_LINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1];
    const lineStr = m[2] ?? m[3];
    const t = parseFileToken(m[0]);
    if (t) results.push({ filePath: t.path, line: t.line });
  }
  return results;
}

export function findPinnedTodo(entries: Entry[]): Entry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.item?.type === "todo" && Array.isArray(e.item.items) && e.item.items.length > 0) return e;
  }
  return null;
}

export function shouldShowLoadOlder(entries: Entry[], hasMore?: boolean): boolean {
  return hasMore === true;
}

// ─── Markdown tokenizer ───────────────────────────────────────────────────────

type Token =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code_block"; lang: string; code: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "bullet_list"; items: string[] }
  | { type: "ordered_list"; items: string[] }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "blank" };

/** `doc` mode is for whole files (Files dock): CRLF/BOM tolerant, and `>` blockquotes. Chat keeps its old behaviour. */
export function tokenizeMarkdown(text: string, doc = false): Token[] {
  const tokens: Token[] = [];
  const lines = doc ? text.replace(/^﻿/, "").split(/\r?\n/) : text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    const fenceMatch = line.match(/^```([^`]*?)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      tokens.push({ type: "code_block", lang, code: codeLines.join("\n") });
      continue;
    }
    // Heading
    const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      tokens.push({ type: "heading", level: hMatch[1].length as 1 | 2 | 3, text: hMatch[2] });
      i++;
      continue;
    }
    if (doc && /^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      tokens.push({ type: "blockquote", text: quoted.join(" ").trim() });
      continue;
    }
    // Table (line contains |)
    if (line.includes("|") && line.trim().startsWith("|")) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const parseRow = (l: string) =>
        l.split("|").slice(1, -1).map((c) => c.trim());
      const header = parseRow(tableLines[0]);
      // skip separator row (---)
      const dataStart = tableLines[1]?.match(/^\|[\s\-|]+\|$/) ? 2 : 1;
      const rows = tableLines.slice(dataStart).map(parseRow);
      tokens.push({ type: "table", header, rows });
      continue;
    }
    // Bullet list
    if (line.match(/^(\s*[-*]\s)/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^(\s*[-*]\s)/)) {
        items.push(lines[i].replace(/^\s*[-*]\s/, ""));
        i++;
      }
      tokens.push({ type: "bullet_list", items });
      continue;
    }
    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      tokens.push({ type: "ordered_list", items });
      continue;
    }
    // Blank line
    if (line.trim() === "") {
      tokens.push({ type: "blank" });
      i++;
      continue;
    }
    // Paragraph
    tokens.push({ type: "paragraph", text: line });
    i++;
  }
  return tokens;
}

// ─── Inline renderers ─────────────────────────────────────────────────────────

function openFileTarget(t: { path: string; line: number | null; isDir: boolean }) {
  openRightDockTab("Files", { filePath: t.isDir ? `${t.path}/` : t.path, line: t.line ?? undefined });
}

function renderInline(text: string, agentId?: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Process: bold, inline code, links, file:line, images, plain text
  const patterns = [
    // Local image
    { re: /!\[([^\]]*)\]\(((?:file:\/\/|[A-Za-z]:[\\/])[^)\s]+)\)/g, key: "img" },
    // Bold
    { re: /\*\*([^*]+)\*\*/g, key: "bold" },
    // Inline code
    { re: /`([^`]+)`/g, key: "code" },
    // Link
    { re: /\[([^\]]+)\]\(([^)]+)\)/g, key: "link" },
    // File:line (colon notation)
    { re: /(?<![`"'\w@.\/\x5c:#~-])([a-zA-Z0-9_.\-\/\x5c]+\.[a-zA-Z]{1,6}):(\d+)(?:-\d+)?(?![a-zA-Z0-9_])/g, key: "filelink" },
    // File:line (#L notation)
    { re: /(?<![`"'\w@.\/\x5c:#~-])([a-zA-Z0-9_.\-\/\x5c]+\.[a-zA-Z]{1,6})#L(\d+)(?:-L?\d+)?(?![a-zA-Z0-9_])/g, key: "filelink2" },
    // Bare repo path (dir/file.ext, dir/); validated by parseFileToken
    { re: BARE_PATH_RE, key: "barepath" },
  ];

  // Build a combined regex
  const combined = new RegExp(
    patterns.map((p) => `(${p.re.source})`).join("|"),
    "g",
  );

  let last = 0;
  let keyIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = combined.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={keyIdx++}>{text.slice(last, m.index)}</span>);
    }
    // determine which group matched
    if (m[1] !== undefined) {
      // local image
      const src = localImageSrc(m[3], agentId);
      nodes.push(
        <img key={keyIdx++} src={src} alt={m[2] || "image"} className="tl-thumb" />,
      );
    } else if (m[4] !== undefined) {
      // bold
      nodes.push(<strong key={keyIdx++}>{m[5]}</strong>);
    } else if (m[6] !== undefined) {
      // inline code
      const tgt = parseFileToken(m[7], { backticked: true });
      nodes.push(
        tgt ? (
          <code key={keyIdx++} className="tl-icode tl-file-link" role="button" tabIndex={0}
            data-testid="tl-file-link" onClick={() => openFileTarget(tgt)}
            onKeyDown={(e) => { if (e.key === "Enter") openFileTarget(tgt); }}>{m[7]}</code>
        ) : (
          <code key={keyIdx++} className="tl-icode">{m[7]}</code>
        ),
      );
    } else if (m[8] !== undefined) {
      // link
      nodes.push(
        <a key={keyIdx++} href={m[10]} target="_blank" rel="noopener noreferrer">{m[9]}</a>,
      );
    } else if (m[11] !== undefined || m[14] !== undefined) {
      // path:line / path#L12 (incl. :200-213); gated by parseFileToken like every other chat path
      const raw = (m[11] ?? m[14]) as string;
      const tgt = parseFileToken(raw);
      nodes.push(
        tgt ? (
          <button key={keyIdx++} className="tl-file-link" data-testid="tl-file-link"
            onClick={() => openFileTarget(tgt)}>{raw}</button>
        ) : (
          <span key={keyIdx++}>{raw}</span>
        ),
      );
    } else if (m[17] !== undefined) {
      // bare repo path
      const tgt = parseFileToken(m[17]);
      nodes.push(
        tgt ? (
          <button key={keyIdx++} className="tl-file-link" data-testid="tl-file-link"
            onClick={() => openFileTarget(tgt)}>{m[17]}</button>
        ) : (
          <span key={keyIdx++}>{m[17]}</span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(<span key={keyIdx++}>{text.slice(last)}</span>);
  }
  return nodes;
}

// ─── CodeBlock component ──────────────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="tl-code-block" style={{ position: "relative" }}>
      <button
        data-testid="code-copy-btn"
        style={{ position: "absolute", top: 4, right: 4, fontSize: "0.75em", userSelect: "none" }}
        onClick={copy}
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
      {lang && <div className="tl-code-lang">{lang}</div>}
      <pre><code>{code}</code></pre>
    </div>
  );
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

export function MarkdownRenderer({ text, agentId, doc = false }: { text: string; agentId?: string; doc?: boolean }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const liveSpinOff = useSpinOff(agentId ?? null);
  const liveSendTo = useSendTo(agentId ?? null);
  const liveLooksDoneId = useLooksDoneId(agentId ?? null);
  const tokens = tokenizeMarkdown(text, doc);

  const renderInlineWithImages = (t: string) => {
    // Replace local images separately so they can get lightbox
    const parts: React.ReactNode[] = [];
    let last = 0;
    let ki = 0;
    for (const m of t.matchAll(new RegExp(MD_IMAGE.source, "g"))) {
      if (m.index! > last) {
        parts.push(...renderInline(t.slice(last, m.index), agentId).map((n, i) =>
          typeof n === "string" ? n : <span key={`${ki}-${i}`}>{n}</span>
        ));
      }
      const src = localImageSrc(m[2], agentId);
      parts.push(
        <img
          key={ki++}
          src={src}
          alt={m[1] || "image"}
          className="tl-thumb"
          onClick={() => setLightboxSrc(src)}
        />,
      );
      last = m.index! + m[0].length;
    }
    if (last < t.length) {
      parts.push(...renderInline(t.slice(last), agentId));
    }
    return parts;
  };

  const renderToken = (tok: Token, i: number): React.ReactNode => {
    switch (tok.type) {
      case "heading": {
        const lvl = tok.level;
        const cls = `tl-h${lvl}`;
        if (lvl === 1) return <h1 key={i} className={cls}>{tok.text}</h1>;
        if (lvl === 2) return <h2 key={i} className={cls}>{tok.text}</h2>;
        return <h3 key={i} className={cls}>{tok.text}</h3>;
      }
      case "code_block": {
        const lang = tok.lang.trim().toLowerCase();
        if (lang === "mermaid") {
          return <MermaidView key={i} code={tok.code} />;
        }
        if (lang === "vs:spin-off" || /^\s*vs:spin-off\s*(\n|$)/i.test(tok.code)) {
          const teams = parseSpinOff(`\`\`\`vs:spin-off\n${tok.code.replace(/^\s*vs:spin-off\s*\n?/i, "")}\n\`\`\``);
          const pin = findPinForAgent(agentId);
          if (teams?.length && pin) {
            return (
              <div key={i} className="tl-spinoff-block" data-testid="tl-spinoff-block">
                <CodeBlock lang={tok.lang || "vs:spin-off"} code={tok.code} />
                <SpinOffCard pin={pin} offer={{ id: liveSpinOff?.id ?? `${agentId ?? "inline"}:inline:${i}`, teams }} variant="bar" />
              </div>
            );
          }
        }
        if (lang.startsWith("vs:send-to") || /^\s*vs:send-to\s+[A-Za-z0-9_-]+/m.test(tok.code)) {
          const parsedSendTo = parseSendTo(lang.startsWith("vs:send-to") ? `${tok.lang}\n${tok.code}` : tok.code);
          const pin = findPinForAgent(agentId);
          if (parsedSendTo && pin) {
            return (
              <div key={i} className="tl-sendto-block" data-testid="tl-sendto-block">
                <CodeBlock lang={tok.lang || "vs:send-to"} code={tok.code} />
                <SendToCard pin={pin} offer={{ ...parsedSendTo, id: liveSendTo?.id ?? `${agentId ?? "inline"}:inline:${i}` }} variant="bar" />
              </div>
            );
          }
        }
        if (lang === "vs:looks-done" || hasLooksDone(tok.code)) {
          const pin = findPinForAgent(agentId);
          if (pin && !isHubPin(pin)) {
            return (
              <div key={i} className="tl-looksdone-block" data-testid="tl-looksdone-block">
                <CodeBlock lang={tok.lang || "vs:looks-done"} code={tok.code} />
                <LooksDoneCard pin={pin} messageId={liveLooksDoneId ?? `${agentId ?? "inline"}:inline:${i}`} />
              </div>
            );
          }
        }
        return <CodeBlock key={i} lang={tok.lang} code={tok.code} />;
      }
      case "table":
        return (
          <table key={i} className="tl-table">
            <thead>
              <tr>{tok.header.map((h, j) => <th key={j}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {tok.rows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInlineWithImages(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        );
      case "bullet_list":
        return (
          <ul key={i} className="tl-ul">
            {tok.items.map((item, j) => <li key={j}>{renderInlineWithImages(item)}</li>)}
          </ul>
        );
      case "ordered_list":
        return (
          <ol key={i} className="tl-ol">
            {tok.items.map((item, j) => <li key={j}>{renderInlineWithImages(item)}</li>)}
          </ol>
        );
      case "paragraph":
        return <p key={i} className="tl-p">{renderInlineWithImages(tok.text)}</p>;
      case "blockquote":
        return <blockquote key={i} className="tl-quote">{renderInlineWithImages(tok.text)}</blockquote>;
      case "blank":
        return null;
    }
  };

  return (
    <>
      <div className="tl-md">{tokens.map((tok, i) => renderToken(tok, i))}</div>
      {lightboxSrc && (
        <div className="img-lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="full size" />
        </div>
      )}
    </>
  );
}

// ─── Unified diff view ────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="tl-diff">
      {diff.split("\n").map((line, i) => {
        const color = line.startsWith("+") ? "#1a7f37" : line.startsWith("-") ? "#cf222e" : undefined;
        return <div key={i} style={{ color }}>{line}</div>;
      })}
    </pre>
  );
}

// ─── Tool detail view ─────────────────────────────────────────────────────────

function ToolDetail({ it, d }: { it: any; d: any }) {
  const isShell = d.type === "shell" || it.name === "Bash";
  const hasDiff = d.unifiedDiff ?? d.diff ?? (d.oldString != null ? d.oldString : null) ?? (d.newString != null ? d.newString : null) ?? d.content;
  if (isShell) {
    const output = d.output ?? d.stdout ?? d.stderr ?? it.output ?? "";
    return (
      <div data-testid="tl-tool-detail" className="tl-tool-detail">
        {d.command && <div><b>Command:</b> <code>{d.command}</code></div>}
        {d.cwd && <div><b>cwd:</b> <code>{d.cwd}</code></div>}
        {d.exitCode != null && (
          <div>
            <span
              className="tl-exit-badge"
              style={{ background: d.exitCode === 0 ? "#1a7f37" : "#cf222e", color: "#fff", padding: "1px 6px", borderRadius: 3 }}
            >
              exit {d.exitCode}
            </span>
          </div>
        )}
        {output && (
          <pre className="tl-tool-output" style={{ maxHeight: 240, overflow: "auto" }}>{String(output)}</pre>
        )}
        {it.error && <div className="tl-tool-error" style={{ color: "#ff4d6d" }}>{formatToolError(it.error)}</div>}
      </div>
    );
  }
  if (hasDiff != null) {
    const diffText = d.unifiedDiff ?? d.diff ?? "";
    if (diffText) {
      return (
        <div data-testid="tl-tool-detail" className="tl-tool-detail">
          <DiffView diff={diffText} />
          {it.error && <div style={{ color: "#ff4d6d" }}>{formatToolError(it.error)}</div>}
        </div>
      );
    }
    // oldString/newString or content preview
    const content = d.content ?? d.newString ?? d.oldString ?? "";
    return (
      <div data-testid="tl-tool-detail" className="tl-tool-detail">
        <pre style={{ maxHeight: 240, overflow: "auto" }}>{String(content).slice(0, 2000)}</pre>
        {it.error && <div style={{ color: "#ff4d6d" }}>{formatToolError(it.error)}</div>}
      </div>
    );
  }
  // Read/other
  const preview = d.content ?? d.output ?? d.result;
  return (
    <div data-testid="tl-tool-detail" className="tl-tool-detail">
      {preview != null ? (
        <pre style={{ maxHeight: 240, overflow: "auto" }}>{String(preview).slice(0, 2000)}</pre>
      ) : (
        <pre style={{ maxHeight: 240, overflow: "auto" }}>{JSON.stringify(d ?? it.input, null, 2)}</pre>
      )}
      {it.error && <div style={{ color: "#ff4d6d" }}>{formatToolError(it.error)}</div>}
    </div>
  );
}

// ─── Sub-agent body ───────────────────────────────────────────────────────────

function SubAgentBody({ agentId, subagentKey, d }: { agentId: string; subagentKey: string; d: any }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (DEMO) {
      setEntries([{ item: { type: "assistant_message", text: "sub-agent output" }, seqStart: 0 }]);
      setLoading(false);
      return;
    }
    daemonClient
      .fetchProviderSubagentTimeline(agentId, subagentKey)
      .then((r: any) => {
        setEntries((r.entries ?? []) as Entry[]);
      })
      .catch(() => {
        setEntries([]);
      })
      .finally(() => setLoading(false));
  }, [agentId, subagentKey]);

  const previewText = d.output ?? d.prompt ?? d.result;

  return (
    <div data-testid="tl-subagent-body" style={{ paddingLeft: 20, borderLeft: "2px solid #888", marginTop: 4 }}>
      {previewText && <div className="muted">{String(previewText).slice(0, 200)}</div>}
      {loading && <div className="muted">Loading…</div>}
      {entries?.map((e, i) => (
        <TimelineItem key={e.seqStart ?? i} e={e} agentId={agentId} />
      ))}
    </div>
  );
}

// ─── CopyButton helper ────────────────────────────────────────────────────────

function CopyMsgButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button data-testid="tl-copy-msg-btn" className="tl-park-btn" onClick={copy}>
      {copied ? "✓ Copied" : "📋 Copy"}
    </button>
  );
}

// ─── Inline file-link renderer for tool summaries ─────────────────────────────

function SummaryWithLinks({ text }: { text: string }) {
  const links = extractFileLinks(text);
  if (!links.length) return <span className="muted">{text}</span>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let ki = 0;
  const re = new RegExp(FILE_LINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={ki++} className="muted">{text.slice(last, m.index)}</span>);
    const tgt = parseFileToken(m[0]);
    parts.push(
      tgt ? (
        <button key={ki++} className="tl-file-link" data-testid="tl-file-link"
          onClick={() => openFileTarget(tgt)}>{m[0]}</button>
      ) : (
        <span key={ki++} className="muted">{m[0]}</span>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={ki++} className="muted">{text.slice(last)}</span>);
  return <>{parts}</>;
}

function RewindButton({ agentId, e, onRewound }: { agentId: string; e: Entry; onRewound?: (e: Entry) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState<string>(e.item?.text ?? "");
  const go = async (mode: RewindMode) => {
    const req = buildRewindRequest(agentId, e, mode, text);
    setBusy(true);
    setErr(null);
    try {
      if (DEMO) {
        onRewound?.(e);
      } else {
        if (!req) throw new Error("this message has no rewind id");
        await (daemonClient as any).rewindAgent(req.agentId, req.messageId, req.mode);
        if (req.resend) await (daemonClient as any).sendMessage(agentId, req.resend);
        else onRewound?.(e);
      }
      setOpen(false);
    } catch (x) {
      setErr(String((x as Error)?.message ?? x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ position: "relative" }}>
      <button className="tl-park-btn" data-testid="tl-rewind-btn" title="Rewind to this message" onClick={() => setOpen((v) => !v)}>
        ↺ Rewind
      </button>
      {open && (
        <div className="tl-rewind-popover" data-testid="tl-rewind-popover" style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, marginTop: 4 }}>
          {REWIND_MODES.map((m) => (
            <button key={m.mode} className="btn small" disabled={busy} data-testid={`tl-rewind-${m.mode}`} onClick={() => void go(m.mode)}>
              {m.label}
            </button>
          ))}
          <label style={{ fontSize: 11 }}>
            Edit &amp; Resend (optional)
            <textarea data-testid="tl-rewind-edit" rows={2} value={text} onChange={(ev) => setText(ev.target.value)} style={{ width: "100%" }} />
          </label>
          {err && <div className="tl tl-error">{err}</div>}
        </div>
      )}
    </span>
  );
}

// ─── TimelineItem ─────────────────────────────────────────────────────────────

const CLICK_GUARD_TAGS = new Set(["a", "button", "input", "textarea", "select", "img"]);

/** A click selects a message unless it ends a text selection or lands on an interactive element. */
export function shouldSelectMessageOnClick(targetTagNames: string[], selectionText: string): boolean {
  if (selectionText.length > 0) return false;
  return !targetTagNames.some((t) => CLICK_GUARD_TAGS.has(t.toLowerCase()) || t === ".tl-actions");
}

function onMessageClick(ev: React.MouseEvent<HTMLElement>, onSelect?: () => void) {
  if (!onSelect) return;
  const names: string[] = [];
  for (let n = ev.target as HTMLElement | null; n && n !== ev.currentTarget; n = n.parentElement) {
    names.push(n.tagName.toLowerCase());
    if (n.classList?.contains("tl-actions") || n.classList?.contains("copy-btn")) names.push(".tl-actions");
  }
  if (shouldSelectMessageOnClick(names, window.getSelection()?.toString() ?? "")) onSelect();
}

export function TimelineItem({
  e,
  agentId,
  onParkText,
  onRewound,
  selected = false,
  onSelect,
  latestReasoning = false,
}: {
  e: Entry;
  agentId: string;
  onParkText?: (text: string) => void;
  onRewound?: (e: Entry) => void;
  selected?: boolean;
  onSelect?: () => void;
  /** The most recent thought in the loaded timeline opens by default; a user toggle still wins. */
  latestReasoning?: boolean;
}) {
  const it = e.item;
  // null = not toggled yet: tool rows follow Settings › Chat › Collapse successful tool calls.
  const [expandedState, setExpanded] = useState<boolean | null>(null);
  const expanded = expandedState ?? false;
  const [collapseTools] = usePref("chat.collapseToolCalls");
  if (!it || typeof it !== "object") return null;

  if (isCompaction(it) || (it.type === "notification" && typeof it.message === "string" && it.message.includes("compacted"))) {
    return (
      <div data-testid="tl-compaction-row" className="tl tl-compaction" style={{ textAlign: "center", color: "#888", borderTop: "1px dashed #888", borderBottom: "1px dashed #888", padding: "2px 0", fontSize: "0.85em" }}>
        ✂ Context compacted{(it.summary || it.detail) ? ` — ${it.summary ?? it.detail}` : ""}
      </div>
    );
  }

  switch (it.type) {
    case "user_message": {
      const clean = stripBootPreamble(typeof it.text === "string" ? it.text : "");
      const urls: string[] = it.images?.length
        ? it.images.map((im: any) => (im.data ? `data:${im.mimeType ?? "image/png"};base64,${im.data}` : im.url)).filter(Boolean)
        : sentImagesFor(agentId, it.text);
      const sent = parseSentAttachments(clean);
      return (
        <div className={`tl tl-user${selected ? " tl-selected" : ""}`} data-selected={selected ? "true" : undefined} onClick={(ev) => onMessageClick(ev, onSelect)} onContextMenu={(ev) => openContextMenu(ev, messageCtxItems(clean, agentId, onParkText, selectionWithin(ev.currentTarget)))}>
          {urls.length > 0 && (
            <div className="tl-images">
              {urls.map((u, i) => (
                <img key={i} src={u} alt="sent attachment" />
              ))}
            </div>
          )}
          {sent.chips.length ? sent.body : clean}
          <Stamp iso={e.timestamp} />
          {sent.chips.length > 0 && (
            <div className="tl-file-chips">
              {sent.chips.map((c, i) =>
                c.path && repoPathFor(agentId, c.path) ? (
                  <button key={i} className="chip file-chip" data-testid="tl-file-chip" title={c.path} onClick={(ev) => { ev.stopPropagation(); openFileTarget({ path: repoPathFor(agentId, c.path!)!, line: null, isDir: false }); }}>
                    📄 {c.name}
                  </button>
                ) : (
                  <span key={i} className="chip file-chip" data-testid="tl-file-chip">📄 {c.name}</span>
                ),
              )}
            </div>
          )}
          {selected && <div className="tl-actions">
            <CopyMsgButton text={clean} />
            {onParkText && clean.trim() && (
              <button className="tl-park-btn" title="Park message lines in Idea Inbox (0 tokens)" onClick={() => onParkText(clean)}>
                📥 Park in Inbox
              </button>
            )}
            <RewindButton agentId={agentId} e={e} onRewound={onRewound} />
          </div>}
        </div>
      );
    }

    case "assistant_message":
      return (
        <div className={`tl tl-assistant${selected ? " tl-selected" : ""}`} data-selected={selected ? "true" : undefined} onClick={(ev) => onMessageClick(ev, onSelect)} onContextMenu={(ev) => openContextMenu(ev, messageCtxItems(it.text ?? "", agentId, onParkText, selectionWithin(ev.currentTarget)))}>
          {typeof it.text === "string" ? <MarkdownRenderer text={it.text} agentId={agentId} /> : it.text}
          <Stamp iso={e.timestamp} />
          {selected && <div className="tl-actions">
            <CopyMsgButton text={it.text ?? ""} />
            {onParkText && typeof it.text === "string" && it.text.trim() && (
              <button className="tl-park-btn" title="Park message lines in Idea Inbox (0 tokens)" onClick={() => onParkText(it.text)}>
                📥 Park in Inbox
              </button>
            )}
          </div>}
        </div>
      );

    case "reasoning": {
      const txt = reasoningText(it);
      const open = expandedState ?? latestReasoning;
      const preview = txt.slice(0, 80);
      return (
        <div
          data-testid="tl-reasoning-row"
          className="tl tl-reasoning"
          style={{ cursor: "pointer", color: "#888", fontSize: "0.9em" }}
          onClick={() => setExpanded(!open)}
        >
          {open ? "▾" : "▸"} Thinking…{!open && preview ? ` ${preview}${txt.length > 80 ? "…" : ""}` : ""}
          {open && (
            <div className="tl-reasoning-body" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
              {txt}
            </div>
          )}
        </div>
      );
    }

    case "tool_call": {
      const d = it.detail ?? {};
      const failed = isFailedTool(it, d);
      const isSubAgent = isSubAgentTool(it, d);
      const errText = formatToolError(it.error);

      if (isSubAgent) {
        const subagentKey = d.subAgentId ?? d.agentId ?? it.callId ?? "";
        const summary = formatToolError(d.description ?? d.type ?? it.name ?? "");
        return (
          <div
            data-testid="tl-subagent-row"
            className={`tl tl-sub ${it.status ?? ""}`}
            style={failed ? { borderLeft: "3px solid #ff4d6d" } : undefined}
            onClick={() => setExpanded((v) => !v)}
          >
            <span style={{ cursor: "pointer" }}>{expanded ? "▾" : "▸"}</span>{" "}
            <b>◈ sub-agent</b> {d.subAgentType ? `[${d.subAgentType}] ` : ""}
            {summary} <span className="muted">· {it.status}</span>
            {failed && errText && <div style={{ color: "#ff4d6d", fontSize: "0.85em" }}>{errText}</div>}
            {expanded && (
              <SubAgentBody agentId={agentId} subagentKey={subagentKey} d={d} />
            )}
          </div>
        );
      }

      const open = expandedState ?? toolStartsExpanded(failed, collapseTools);
      const rawSummary =
        d.type === "shell" ? d.command : d.filePath ?? d.query ?? d.url ?? d.label ?? d.text ?? "";
      const summaryStr = formatToolError(rawSummary).slice(0, 160);
      return (
        <div
          data-testid="tl-tool-row"
          className={`tl tl-tool ${it.status ?? ""}${failed ? " failed" : ""}`}
          style={failed ? { borderLeft: "3px solid #ff4d6d" } : undefined}
          onClick={() => setExpanded(!open)}
        >
          <span style={{ cursor: "pointer" }}>{open ? "▾" : "▸"}</span>{" "}
          <span className="tool-name">{it.name}</span>{" "}
          <SummaryWithLinks text={summaryStr} />
          {failed && errText && <span style={{ color: "#ff4d6d", marginLeft: 4 }}>{errText}</span>}
          {open && <ToolDetail it={it} d={d} />}
        </div>
      );
    }

    case "todo":
      return (
        <div className="tl tl-todo">
          {(Array.isArray(it.items) ? it.items : []).map((t: any, i: number) => (
            <div key={i}>
              {t.completed || t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {formatToolError(t.text)}
            </div>
          ))}
        </div>
      );

    case "error":
      return <div className="tl tl-error">{formatToolError(it.message ?? it.error)}</div>;

    case "notification":
      return <div className={`tl tl-note ${it.level}`}>{formatToolError(it.message)}</div>;

    case "provider_switch":
      return (
        <div data-testid="tl-provider-switch-row" className="tl tl-compaction tl-provider-switch" style={{ textAlign: "center", color: "#888", borderTop: "1px dashed #888", borderBottom: "1px dashed #888", padding: "2px 0", fontSize: "0.85em" }}>
          ── Switched to {it.label || "new provider"} ──
        </div>
      );

    default:
      return null;
  }
}

// ─── useTimeline ──────────────────────────────────────────────────────────────

export function useTimeline(agentId: string, status: string, active = true, predecessorId?: string, switchLabel?: string) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [predecessor, setPredecessor] = useState<{ entries: Entry[]; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const earliestCursor = useRef<any>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const stale = useRef(false);
  const lastSeq = useRef<number | null>(null);
  const reload = useRef<() => void>(() => {});
  // Feel pass: click → transcript painted for a freshly opened agent (no-op unless perfStart ran).
  useEffect(() => {
    if (loaded && active) perfEndPainted("open-agent", agentId);
  }, [loaded, active, agentId]);

  // Stitch the predecessor's tail timeline ahead of this (fresh) agent's own entries so the conversation
  // stays continuously visible across a provider switch. Fetched once; never touched by load()/soon()/mergeLiveItem.
  useEffect(() => {
    if (DEMO || !predecessorId || predecessorId === "start-brainstorm") {
      setPredecessor(null);
      return;
    }
    let alive = true;
    client.agents
      .ref(predecessorId)
      .timeline.refetch({ direction: "tail", limit: 40, projection: "projected" })
      .then((t) => {
        if (!alive) return;
        const predEntries = (t.entries ?? []) as Entry[];
        setPredecessor({ entries: predEntries, label: switchLabel || "new provider" });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [predecessorId, switchLabel]);

  const combinedEntries = useMemo<Entry[]>(() => {
    if (!predecessor) return entries;
    const divider: Entry = { item: { type: "provider_switch", label: predecessor.label }, seqStart: -1 };
    return [...predecessor.entries, divider, ...entries];
  }, [predecessor, entries]);

  useEffect(() => {
    if (agentId && entries.length) noteTimelineOffers(agentId, entries);
  }, [agentId, entries]);

  useEffect(() => {
    if (DEMO) {
      setEntries(demoTimeline(agentId) as Entry[]);
      setHasMore(false);
      return;
    }
    let alive = true;
    setLoaded(false);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handle = client.agents.ref(agentId);

    const load = async () => {
      try {
        const t = await handle.timeline.refetch({ direction: "tail", limit: 60, projection: "projected" });
        if (!alive) return;
        if (t.error) setError(String(t.error));
        else {
          setError(null);
          const newEntries = t.entries as Entry[];
          setEntries(newEntries);
          lastSeq.current = maxEntrySeq(newEntries);
          const tAny = t as any;
          setHasMore(tAny.hasOlder ?? newEntries.length >= 60);
          const startCur = tAny.startCursor;
          if (startCur && typeof startCur.epoch === "string" && typeof startCur.seq === "number") {
            earliestCursor.current = startCur;
          } else if (newEntries.length > 0) {
            const first = newEntries[0] as any;
            earliestCursor.current = { epoch: first.timestamp ?? "", seq: first.seqStart ?? 0 };
          }
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) setLoaded(true);
    };

    // The live stream already folds into `entries` (mergeLiveItem), so a refetch per event only re-reads 60
    // entries the client has. soon() now runs for a seq gap (lost rows) or, debounced to a quiet stream, for
    // events that can't be verified; turn end refetches via the [agentId, status] effect below.
    const soon = (delay: number, debounce: boolean) => {
      if (!activeRef.current) {
        stale.current = true;
        return;
      }
      if (timer) {
        if (!debounce) return;
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        load();
      }, delay);
    };

    reload.current = load;
    load();
    const sub = handle.timeline.subscribe((ev: PaseoAgentTimelineEvent) => {
      if (ev.event.type === "timeline") {
        const item = ev.event.item;
        const seq = "seq" in ev ? ev.seq : undefined;
        const ts = "timestamp" in ev ? ev.timestamp : undefined;
        perfSendEvent(agentId, (item as any)?.type === "assistant_message");
        setEntries((cur) => mergeLiveItem(cur, item, ts, seq));
        const need = syncNeeded(lastSeq.current, seq);
        if (seq != null && (lastSeq.current == null || seq > lastSeq.current)) lastSeq.current = seq;
        if (need === "gap") soon(600, false);
        else if (need === "unverified") soon(2500, true);
      } else {
        soon(2500, true);
      }
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (typeof sub === "function") sub();
      else if (sub && typeof (sub as any).unsubscribe === "function") (sub as any).unsubscribe();
    };
  }, [agentId]);

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
        if (!t.error) {
          const newEntries = t.entries as Entry[];
          setEntries(newEntries);
          lastSeq.current = maxEntrySeq(newEntries);
          const tAny = t as any;
          setHasMore(tAny.hasOlder ?? newEntries.length >= 60);
          const startCur = tAny.startCursor;
          if (startCur && typeof startCur.epoch === "string" && typeof startCur.seq === "number") {
            earliestCursor.current = startCur;
          } else if (newEntries.length > 0) {
            const first = newEntries[0] as any;
            earliestCursor.current = { epoch: first.timestamp ?? "", seq: first.seqStart ?? 0 };
          }
        }
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

  const loadMore = useCallback(async () => {
    if (DEMO || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const cursor = earliestCursor.current;
      const t = await daemonClient.fetchAgentTimeline(agentId, {
        direction: "before" as any,
        cursor,
        limit: 60,
        projection: "projected" as any,
      });
      const tAny = t as any;
      const older = (tAny.entries ?? tAny.payload?.entries ?? []) as Entry[];
      if (older.length > 0) {
        setEntries((prev) => [...older, ...prev]);
        const startCur = tAny.startCursor ?? tAny.payload?.startCursor;
        if (startCur && typeof startCur.epoch === "string" && typeof startCur.seq === "number") {
          earliestCursor.current = startCur;
        } else {
          const first = older[0] as any;
          earliestCursor.current = { epoch: first.timestamp ?? "", seq: first.seqStart ?? 0 };
        }
        setHasMore(tAny.hasOlder ?? tAny.payload?.hasOlder ?? (older.length >= 60));
      } else {
        setHasMore(false);
      }
    } catch (e) {
      setError(`Failed to load older messages: ${e}`);
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, hasMore, loadingMore]);

  return { entries: combinedEntries, error, hasMore, loadingMore, loadMore, loaded };
}

// ─── PinnedTodo ───────────────────────────────────────────────────────────────

function PinnedTodo({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false);
  const it = entry.item;
  const items: any[] = Array.isArray(it.items) ? it.items : [];
  const done = items.filter((t) => t.completed || t.status === "completed").length;
  const total = items.length;
  return (
    <div
      data-testid="tl-pinned-todo"
      style={{ background: "var(--bg, #1e1e1e)", borderBottom: "1px solid #444", padding: "4px 8px", cursor: "pointer" }}
      onClick={() => setOpen((v) => !v)}
    >
      {open ? "▾" : "▸"} 📋 Plan / Tasks ({done}/{total})
      {open && (
        <div style={{ marginTop: 4, fontSize: "0.9em" }}>
          {items.map((t, i) => (
            <div key={i}>
              {t.completed || t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

type TimelineProps = {
  agentId: string;
  entries: Entry[];
  error: string | null;
  onParkText?: (text: string) => void;
  hasMore?: boolean;
  loadMore?: () => void;
  loadingMore?: boolean;
  /** False until the first fetch for this agent finishes (drives the delayed skeleton). */
  loaded?: boolean;
  agentStatus?: string;
  agentTitle?: string | null;
};

export function Timeline({
  agentId,
  entries,
  error,
  onParkText,
  hasMore = false,
  loadMore = () => {},
  loadingMore = false,
  loaded = true,
  agentStatus,
  agentTitle,
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  const [cut, setCut] = useState<Entry | null>(null);
  const cutLen = useRef(0);
  // New turns after a rewind arrive past the cut; drop the cut so they show.
  useEffect(() => {
    if (cut && entries.length !== cutLen.current) setCut(null);
  }, [entries.length, cut]);
  useEffect(() => {
    setCut(null);
  }, [agentId]);
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [barOpen, setBarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchLocation[]>([]);
  const [hitIdx, setHitIdx] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [barMsg, setBarMsg] = useState("");
  const [prompts, setPrompts] = useState<TimelinePrompt[]>([]);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const curSeq = useRef<number | null>(null);
  const reqId = useRef(0);
  const [pendingJump, setPendingJump] = useState<{ seq: number; n: number } | null>(null);
  const base = cut ? truncateAfter(entries, cut) : entries;
  const shown = filterEntries(base, filter);
  const slowFirstLoad = useDelayedBusy(!loaded && entries.length === 0);
  const slowMore = useDelayedBusy(loadingMore);
  const slowSearch = useDelayedBusy(searching);
  const pinnedTodo = findPinnedTodo(shown);

  const allPending = useSyncExternalStore(subscribePending, getPending);
  const pendingHere = pendingFor(allPending, agentId);
  // Drop optimistic bubbles once the daemon's own user_message entry has arrived (no duplicate).
  const covered = reconciledIds(pendingHere, entries);
  useEffect(() => {
    dropReconciled(covered);
  }, [covered.join(",")]);
  const lastEntry = entries[entries.length - 1];
  const tailSig = [
    entries.length,
    lastEntry?.seqStart,
    lastEntry?.item?.type,
    lastEntry?.item?.status,
    reasoningText(lastEntry?.item).length || String(lastEntry?.item?.text ?? "").length,
    JSON.stringify(lastEntry?.item?.detail ?? "").length,
    pendingHere.length,
  ].join("|");
  const stickToBottom = () => {
    const el = timelineRef.current;
    if (el && pinned.current && el.offsetParent) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(stickToBottom, [tailSig]);
  // Rows grow without the entry list changing (images, expanding thoughts, markdown): follow while pinned.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(stickToBottom);
    const watch = () => { for (const c of Array.from(el.children)) ro.observe(c); };
    watch();
    const mo = new MutationObserver(() => { ro.disconnect(); watch(); stickToBottom(); });
    mo.observe(el, { childList: true });
    return () => { mo.disconnect(); ro.disconnect(); };
  }, [agentId]);

  useEffect(() => {
    setFilter("all"); setBarOpen(false); setQuery(""); setHits([]); setHitIdx(-1); setPrompts([]); setPromptsOpen(false); setBarMsg("");
    curSeq.current = null;
    reqId.current++;
    setPendingJump(null); setSearching(false);
  }, [agentId]);
  // The drawer header's search button fires this.
  useEffect(() => {
    const on = (ev: Event) => {
      if ((ev as CustomEvent).detail?.agentId === agentId) setBarOpen((o) => !o);
    };
    window.addEventListener("vs:timeline-search", on);
    return () => window.removeEventListener("vs:timeline-search", on);
  }, [agentId]);
  // Ctrl+F opens (or refocuses) the search bar of the transcript in the active, visible pane.
  useEffect(() => {
    const onFind = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== "f") return;
      const el = timelineRef.current;
      if (!el || !el.offsetParent) return;
      if (document.querySelector(".modal-back, [role='dialog']")) return; // a modal or the palette owns the keyboard
      const slot = el.closest(".pane-slot");
      if (slot && !slot.classList.contains(`pane-${getPanes().activePane}`)) return;
      ev.preventDefault();
      setBarOpen(true);
      el.querySelector<HTMLInputElement>('[data-testid="tl-search-input"]')?.select();
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const jumpToSeq = (seq: number) => {
    curSeq.current = seq; // advance even when the target isn't loaded, so prompt stepping can't stall
    const idx = entryIndexForSeq(base, seq);
    if (idx < 0) { setBarMsg("Older than the loaded history - load older messages first"); return; }
    setBarMsg("");
    if (!matchesFilter(base[idx].item, filter)) setFilter("all");
    setPendingJump((j) => ({ seq: base[idx].seqStart ?? seq, n: (j?.n ?? 0) + 1 }));
  };
  // Scroll + flash after React has committed the (possibly re-filtered) list.
  const handledJump = useRef(0);
  const flashTimer = useRef<{ el: HTMLElement; t: ReturnType<typeof setTimeout> } | null>(null);
  const clearFlash = () => {
    if (!flashTimer.current) return;
    clearTimeout(flashTimer.current.t);
    flashTimer.current.el.classList.remove("tl-flash");
    flashTimer.current = null;
  };
  useEffect(() => clearFlash, []);
  useEffect(() => {
    if (!pendingJump || handledJump.current === pendingJump.n) return;
    handledJump.current = pendingJump.n;
    const marker = timelineRef.current?.querySelector(`[data-tl-seq="${pendingJump.seq}"]`) as HTMLElement | null;
    const el = marker?.nextElementSibling as HTMLElement | null;
    if (!el?.classList.contains("tl")) return; // item rendered nothing
    clearFlash();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("tl-flash");
    flashTimer.current = { el, t: setTimeout(clearFlash, 1800) };
  }, [pendingJump, shown.length]);
  const runSearch = async () => {
    const q = query.trim();
    if (!q) { setHits([]); setHitIdx(-1); setBarMsg(""); return; }
    const my = ++reqId.current;
    setSearching(true);
    try {
      const found = sortedHits(DEMO ? localSearch(base, q) : await searchTimeline(agentId, q));
      if (my !== reqId.current) return;
      setHits(found);
      setBarMsg(found.length ? "" : "No matches");
      setHitIdx(found.length ? found.length - 1 : -1);
      if (found.length) jumpToSeq(found[found.length - 1].seq);
    } catch (err) {
      if (my === reqId.current) setBarMsg(String((err as Error)?.message ?? err));
    } finally {
      if (my === reqId.current) setSearching(false);
    }
  };
  const stepHit = (dir: 1 | -1) => {
    const i = stepIndex(hitIdx, dir, hits.length);
    if (i < 0) return;
    setHitIdx(i);
    jumpToSeq(hits[i].seq);
  };
  const loadPrompts = async (): Promise<TimelinePrompt[]> => {
    const my = reqId.current;
    try {
      const list = DEMO ? localPrompts(base) : await listTimelinePrompts(agentId);
      if (my !== reqId.current) return [];
      setPrompts(list);
      return list;
    } catch (err) {
      if (my === reqId.current) setBarMsg(String((err as Error)?.message ?? err));
      return [];
    }
  };
  const stepPrompt = async (dir: 1 | -1) => {
    const list = await loadPrompts();
    const from = curSeq.current ?? (dir === 1 ? -1 : Infinity);
    const p = adjacentPrompt(list, from, dir);
    if (p) jumpToSeq(p.seq);
  };

  useEffect(() => {
    if (!selectedEntryKey) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setSelectedEntryKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEntryKey]);

  const handleLoadMore = () => {
    const el = timelineRef.current;
    if (!el) {
      loadMore();
      return;
    }
    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop = el.scrollTop;
    loadMore();
    // Restore scroll position after entries are prepended (next paint)
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - prevScrollHeight;
      el.scrollTop = prevScrollTop + delta;
    });
  };

  return (
    <div
      className="timeline"
      ref={timelineRef}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) setSelectedEntryKey(null);
      }}
      onScroll={(e) => {
        const el = e.currentTarget;
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        pinned.current = near;
        setIsPinned((p) => (p === near ? p : near));
      }}
    >
      {(barOpen || pinnedTodo) && <div className="tl-head">
      {barOpen && (
        <div className="tl-bar" data-testid="tl-bar">
          <div className="tl-bar-row">
            <input
              data-testid="tl-search-input"
              autoFocus
              placeholder="Search transcript…"
              value={query}
              onChange={(ev) => { setQuery(ev.target.value); setHits([]); setHitIdx(-1); }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  if (hits.length) stepHit(ev.shiftKey ? -1 : 1);
                  else void runSearch();
                }
                if (ev.key === "Escape") setBarOpen(false);
              }}
            />
            <button className="btn ghost small" data-testid="tl-search-go" disabled={searching} onClick={() => void runSearch()}>{searching ? (slowSearch ? <Spinner /> : "…") : "Find"}</button>
            <button className="btn ghost small" title="Previous match" disabled={!hits.length} onClick={() => stepHit(-1)}>↑</button>
            <button className="btn ghost small" title="Next match" disabled={!hits.length} onClick={() => stepHit(1)}>↓</button>
            <span className="tl-bar-count" data-testid="tl-search-count">{hits.length ? `${hitIdx + 1}/${hits.length}` : ""}</span>
            <button className="btn ghost small" title="Previous prompt" data-testid="tl-prompt-prev" onClick={() => void stepPrompt(-1)}>⇡ Prompt</button>
            <button className="btn ghost small" title="Next prompt" data-testid="tl-prompt-next" onClick={() => void stepPrompt(1)}>⇣ Prompt</button>
            <button className="btn ghost small" title="List my prompts" data-testid="tl-prompt-list-btn" onClick={() => { const o = !promptsOpen; setPromptsOpen(o); if (o) void loadPrompts(); }}>☰</button>
            <button className="btn ghost small" title="Close" onClick={() => setBarOpen(false)}>✕</button>
          </div>
          <div className="tl-bar-row tl-filters" data-testid="tl-filters">
            {TIMELINE_FILTERS.map((f) => (
              <button key={f} className={`chip tl-filter${filter === f ? " on" : ""}`} data-testid={`tl-filter-${f}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
            {filter !== "all" && <span className="tl-bar-count">{shown.length}/{base.length}</span>}
          </div>
          {barMsg && <div className="tl-bar-msg" data-testid="tl-bar-msg">{barMsg}</div>}
          {promptsOpen && (
            <div className="tl-prompts" data-testid="tl-prompts">
              {prompts.length === 0 && <div className="tl-bar-msg">No prompts</div>}
              {prompts.map((p) => (
                <button key={p.seq} className="tl-prompt-row" onClick={() => { jumpToSeq(p.seq); setPromptsOpen(false); }}>
                  <span className="tl-prompt-ts">{p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : `#${p.seq}`}</span> {p.preview}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {pinnedTodo && <PinnedTodo entry={pinnedTodo} />}
      </div>}
      {slowFirstLoad && <TimelineSkeleton />}
      <SubagentList agentId={agentId} entries={entries} isSubAgent={isSubAgentTool} renderBody={(id) => <SubAgentBody agentId={agentId} subagentKey={id} d={{}} />} />
      {shouldShowLoadOlder(entries, hasMore) && (
        <div style={{ textAlign: "center", padding: "4px 0" }}>
          <button
            data-testid="tl-load-older-btn"
            disabled={loadingMore}
            onClick={handleLoadMore}
          >
            {loadingMore ? (slowMore ? <Spinner label="Loading…" /> : "Loading…") : "↑ Load older messages"}
          </button>
        </div>
      )}
      {error && <div className="tl tl-error">{error}</div>}
      {loaded && !error && shown.length === 0 && (
        agentStatus === "running" || agentStatus === "initializing" ? (
          <div className="tl tl-note info" data-testid="tl-booting-indicator">
            <Spinner label={`${agentTitle || "Agent"} is thinking — booting session from brief…`} />
          </div>
        ) : (
          <div className="tl tl-note muted" data-testid="tl-empty-indicator">
            No messages in this session yet. Send a message below to start.
          </div>
        )
      )}
      {shown.map((e, i) => (
        <Fragment key={e.seqStart ?? i}>
        <i hidden data-tl-seq={e.seqStart ?? i} />
        <TimelineErrorBoundary fallbackLabel={`item #${i}`}>
          <TimelineItem
            e={e}
            agentId={agentId}
            onParkText={onParkText}
            onRewound={(x) => { cutLen.current = entries.length; setCut(x); }}
            latestReasoning={e === entries[latestReasoningIndex(entries)]}
            selected={selectedEntryKey === String(e.seqStart ?? i)}
            onSelect={() => setSelectedEntryKey((k) => (k === String(e.seqStart ?? i) ? null : String(e.seqStart ?? i)))}
          />
        </TimelineErrorBoundary>
        </Fragment>
      ))}
      {pendingHere
        .filter((p) => !covered.includes(p.id))
        .map((p) => (
          <div
            key={p.id}
            className="tl tl-user"
            data-testid={`tl-pending-${p.state}`}
            style={{ opacity: p.state === "pending" ? 0.6 : 1, ...(p.state === "failed" ? { borderColor: "var(--red, #e5484d)" } : {}) }}
          >
            <div className="tl-text">{stripBootPreamble(p.text)}</div>
            {p.state === "failed" ? (
              <div className="muted" role="alert">
                Not sent{p.error ? `: ${p.error}` : ""}{" "}
                <button onClick={() => void retrySend(p.id)}>Retry</button>{" "}
                <button onClick={() => dismissPending(p.id)}>Dismiss</button>
              </div>
            ) : (
              <div className="muted">Sending…</div>
            )}
          </div>
        ))}
      <div />
      {!isPinned && (
        <button
          className="tl-jump-bottom"
          data-testid="tl-jump-bottom"
          onClick={() => {
            const el = timelineRef.current;
            pinned.current = true;
            setIsPinned(true);
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ Follow output
        </button>
      )}
    </div>
  );
}
