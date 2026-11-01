import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { daemonClient, client, DEMO } from "./paseo";
import { REWIND_MODES, buildRewindRequest, truncateAfter, type RewindMode } from "./sessionLifecycle";
import { demoTimeline } from "./demo";
import { sentImagesFor } from "./imageDrafts";
import { openRightDockTab } from "./RightDock";

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
            className="btn-ghost"
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
const FILE_LINK_RE = /(?<![`"'(])([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z]{1,6})(?::(\d+)|#L(\d+))(?![a-zA-Z0-9_])/g;

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
    results.push({ filePath, line: lineStr ? parseInt(lineStr, 10) : null });
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
  return !!hasMore || entries.length >= 60;
}

// ─── Markdown tokenizer ───────────────────────────────────────────────────────

type Token =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "code_block"; lang: string; code: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "bullet_list"; items: string[] }
  | { type: "ordered_list"; items: string[] }
  | { type: "paragraph"; text: string }
  | { type: "blank" };

export function tokenizeMarkdown(text: string): Token[] {
  const tokens: Token[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)\s*$/);
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
    { re: /(?<![`"'(])([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z]{1,6}):(\d+)(?![a-zA-Z0-9_])/g, key: "filelink" },
    // File:line (#L notation)
    { re: /(?<![`"'(])([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z]{1,6})#L(\d+)(?![a-zA-Z0-9_])/g, key: "filelink2" },
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
      nodes.push(<code key={keyIdx++} className="tl-icode">{m[7]}</code>);
    } else if (m[8] !== undefined) {
      // link
      nodes.push(
        <a key={keyIdx++} href={m[10]} target="_blank" rel="noopener noreferrer">{m[9]}</a>,
      );
    } else if (m[11] !== undefined) {
      // file:line colon
      const fp = m[12];
      const ln = m[13] ? parseInt(m[13], 10) : null;
      nodes.push(
        <button
          key={keyIdx++}
          className="tl-file-link"
          data-testid="tl-file-link"
          onClick={() => {
            openRightDockTab("Files", { filePath: fp, line: ln ?? undefined });
            navigator.clipboard.writeText(fp).catch(() => {});
          }}
        >
          {m[11]}
        </button>,
      );
    } else if (m[14] !== undefined) {
      // file#L notation
      const fp = m[15];
      const ln = m[16] ? parseInt(m[16], 10) : null;
      nodes.push(
        <button
          key={keyIdx++}
          className="tl-file-link"
          data-testid="tl-file-link"
          onClick={() => {
            openRightDockTab("Files", { filePath: fp, line: ln ?? undefined });
            navigator.clipboard.writeText(fp).catch(() => {});
          }}
        >
          {m[14]}
        </button>,
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
        style={{ position: "absolute", top: 4, right: 4, fontSize: "0.75em" }}
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

function MarkdownRenderer({ text, agentId }: { text: string; agentId?: string }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const tokens = tokenizeMarkdown(text);

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
      case "code_block":
        return <CodeBlock key={i} lang={tok.lang} code={tok.code} />;
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
    const fp = m[1];
    const ln = m[2] ? parseInt(m[2], 10) : m[3] ? parseInt(m[3], 10) : null;
    parts.push(
      <button
        key={ki++}
        className="tl-file-link"
        data-testid="tl-file-link"
        onClick={() => {
          openRightDockTab("Files", { filePath: fp, line: ln ?? undefined });
          navigator.clipboard.writeText(fp).catch(() => {});
        }}
      >
        {m[0]}
      </button>,
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

export function TimelineItem({
  e,
  agentId,
  onParkText,
  onRewound,
}: {
  e: Entry;
  agentId: string;
  onParkText?: (text: string) => void;
  onRewound?: (e: Entry) => void;
}) {
  const it = e.item;
  const [expanded, setExpanded] = useState(false);
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
          <div className="tl-actions">
            <CopyMsgButton text={it.text ?? ""} />
            {onParkText && typeof it.text === "string" && it.text.trim() && (
              <button className="tl-park-btn" title="Park message lines in Idea Inbox (0 tokens)" onClick={() => onParkText(it.text)}>
                📥 Park in Inbox
              </button>
            )}
            <RewindButton agentId={agentId} e={e} onRewound={onRewound} />
          </div>
        </div>
      );
    }

    case "assistant_message":
      return (
        <div className="tl tl-assistant">
          {typeof it.text === "string" ? <MarkdownRenderer text={it.text} agentId={agentId} /> : it.text}
          <div className="tl-actions">
            <CopyMsgButton text={it.text ?? ""} />
            {onParkText && typeof it.text === "string" && it.text.trim() && (
              <button className="tl-park-btn" title="Park message lines in Idea Inbox (0 tokens)" onClick={() => onParkText(it.text)}>
                📥 Park in Inbox
              </button>
            )}
          </div>
        </div>
      );

    case "reasoning": {
      const preview = (it.text ?? it.summary ?? "").slice(0, 80);
      return (
        <div
          data-testid="tl-reasoning-row"
          className="tl tl-reasoning"
          style={{ cursor: "pointer", color: "#888", fontSize: "0.9em" }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▾" : "▸"} Thinking…{!expanded && preview ? ` ${preview}${(it.text ?? it.summary ?? "").length > 80 ? "…" : ""}` : ""}
          {expanded && (
            <div className="tl-reasoning-body" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
              {it.text ?? it.summary ?? ""}
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

      const rawSummary =
        d.type === "shell" ? d.command : d.filePath ?? d.query ?? d.url ?? d.label ?? d.text ?? "";
      const summaryStr = formatToolError(rawSummary).slice(0, 160);
      return (
        <div
          data-testid="tl-tool-row"
          className={`tl tl-tool ${it.status ?? ""}${failed ? " failed" : ""}`}
          style={failed ? { borderLeft: "3px solid #ff4d6d" } : undefined}
          onClick={() => setExpanded((v) => !v)}
        >
          <span style={{ cursor: "pointer" }}>{expanded ? "▾" : "▸"}</span>{" "}
          <span className="tool-name">{it.name}</span>{" "}
          <SummaryWithLinks text={summaryStr} />
          {failed && errText && <span style={{ color: "#ff4d6d", marginLeft: 4 }}>{errText}</span>}
          {expanded && <ToolDetail it={it} d={d} />}
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

    default:
      return null;
  }
}

// ─── useTimeline ──────────────────────────────────────────────────────────────

export function useTimeline(agentId: string, status: string, active = true) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const earliestCursor = useRef<any>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const stale = useRef(false);
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    if (DEMO) {
      setEntries(demoTimeline(agentId) as Entry[]);
      setHasMore(false);
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
          const newEntries = t.entries as Entry[];
          setEntries(newEntries);
          setHasMore(newEntries.length >= 60);
          if (newEntries.length > 0) {
            earliestCursor.current = (newEntries[0] as any).seqStart ?? null;
          }
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };

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
          setHasMore(newEntries.length >= 60);
          if (newEntries.length > 0) {
            earliestCursor.current = (newEntries[0] as any).seqStart ?? null;
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
      const older = (t.entries ?? []) as Entry[];
      if (older.length > 0) {
        setEntries((prev) => [...older, ...prev]);
        earliestCursor.current = (older[0] as any).seqStart ?? cursor;
        setHasMore(older.length >= 60);
      } else {
        setHasMore(false);
      }
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, hasMore, loadingMore]);

  return { entries, error, hasMore, loadingMore, loadMore };
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
      style={{ position: "sticky", top: 0, zIndex: 10, background: "var(--bg, #1e1e1e)", borderBottom: "1px solid #444", padding: "4px 8px", cursor: "pointer" }}
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
};

export function Timeline({
  agentId,
  entries,
  error,
  onParkText,
  hasMore = false,
  loadMore = () => {},
  loadingMore = false,
}: TimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [cut, setCut] = useState<Entry | null>(null);
  const shown = cut ? truncateAfter(entries, cut) : entries;
  const pinnedTodo = findPinnedTodo(shown);

  useEffect(() => {
    const el = timelineRef.current;
    if (el && pinned.current && el.offsetParent) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

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
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {pinnedTodo && <PinnedTodo entry={pinnedTodo} />}
      {shouldShowLoadOlder(entries, hasMore) && (
        <div style={{ textAlign: "center", padding: "4px 0" }}>
          <button
            data-testid="tl-load-older-btn"
            disabled={loadingMore}
            onClick={handleLoadMore}
          >
            {loadingMore ? "Loading…" : "↑ Load older messages"}
          </button>
        </div>
      )}
      {error && <div className="tl tl-error">{error}</div>}
      {shown.map((e, i) => (
        <TimelineErrorBoundary key={e.seqStart ?? i} fallbackLabel={`item #${i}`}>
          <TimelineItem e={e} agentId={agentId} onParkText={onParkText} onRewound={setCut} />
        </TimelineErrorBoundary>
      ))}
      <div />
    </div>
  );
}
