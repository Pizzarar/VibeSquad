import { type ReactNode, useEffect, useState } from "react";

export type PreviewKind =
  | "image"
  | "markdown"
  | "html"
  | "pdf"
  | "audio"
  | "video"
  | "text"
  | "binary";

const EXT_TO_KIND: Record<string, PreviewKind> = {
  // Images
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".ico": "image",
  ".bmp": "image",
  // Markdown
  ".md": "markdown",
  ".markdown": "markdown",
  // HTML
  ".html": "html",
  ".htm": "html",
  // PDF
  ".pdf": "pdf",
  // Audio
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  // Video
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  // Binary
  ".exe": "binary",
  ".dll": "binary",
  ".zip": "binary",
  ".gz": "binary",
  ".tgz": "binary",
  ".7z": "binary",
  ".rar": "binary",
  ".tar": "binary",
  ".woff": "binary",
  ".woff2": "binary",
  ".ttf": "binary",
  ".otf": "binary",
  ".class": "binary",
  ".jar": "binary",
  ".bin": "binary",
  ".so": "binary",
  ".dylib": "binary",
  ".o": "binary",
  ".node": "binary",
  ".wasm": "binary",
  ".pyc": "binary",
  ".sqlite": "binary",
  ".db": "binary",
  // Code / Text
  ".ts": "text",
  ".tsx": "text",
  ".js": "text",
  ".jsx": "text",
  ".mjs": "text",
  ".cjs": "text",
  ".json": "text",
  ".css": "text",
  ".scss": "text",
  ".less": "text",
  ".txt": "text",
  ".log": "text",
  ".yml": "text",
  ".yaml": "text",
  ".toml": "text",
  ".ini": "text",
  ".cfg": "text",
  ".conf": "text",
  ".env": "text",
  ".sh": "text",
  ".bash": "text",
  ".zsh": "text",
  ".ps1": "text",
  ".bat": "text",
  ".cmd": "text",
  ".py": "text",
  ".rb": "text",
  ".rs": "text",
  ".go": "text",
  ".java": "text",
  ".c": "text",
  ".cpp": "text",
  ".h": "text",
  ".hpp": "text",
  ".cs": "text",
  ".php": "text",
  ".swift": "text",
  ".kt": "text",
  ".sql": "text",
  ".graphql": "text",
  ".xml": "text",
  ".csv": "text",
  ".tsv": "text",
};

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".json": "application/json",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".yml": "text/plain",
  ".yaml": "text/plain",
  ".toml": "text/plain",
  ".sh": "text/plain",
  ".ps1": "text/plain",
  ".py": "text/plain",
  ".rs": "text/plain",
  ".go": "text/plain",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".bin": "application/octet-stream",
  ".exe": "application/octet-stream",
  ".dll": "application/octet-stream",
};

function getExtension(filePath: string): string {
  const clean = (filePath || "").split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

function normalizeMime(mime?: string): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

export function classifyPreviewKind(filePath: string, mime?: string): PreviewKind {
  const ext = getExtension(filePath);
  const byExt = ext ? EXT_TO_KIND[ext] : undefined;
  const cleanMime = normalizeMime(mime);

  if (byExt && byExt !== "text") {
    return byExt;
  }
  if (byExt === "text") {
    if (cleanMime === "application/octet-stream" || cleanMime === "binary/octet-stream") {
      return "binary";
    }
    return "text";
  }

  if (cleanMime) {
    if (cleanMime === "image/svg+xml" || cleanMime.startsWith("image/")) return "image";
    if (cleanMime === "text/markdown" || cleanMime === "text/x-markdown") return "markdown";
    if (cleanMime === "text/html" || cleanMime === "application/xhtml+xml") return "html";
    if (cleanMime === "application/pdf") return "pdf";
    if (cleanMime.startsWith("audio/")) return "audio";
    if (cleanMime.startsWith("video/")) return "video";
    if (
      cleanMime === "application/octet-stream" ||
      cleanMime === "binary/octet-stream" ||
      cleanMime === "application/zip" ||
      cleanMime === "application/gzip" ||
      cleanMime === "application/x-tar" ||
      cleanMime === "application/wasm" ||
      cleanMime.startsWith("font/")
    ) {
      return "binary";
    }
    if (
      cleanMime.startsWith("text/") ||
      cleanMime === "application/json" ||
      cleanMime === "application/javascript" ||
      cleanMime === "application/typescript" ||
      cleanMime === "application/xml" ||
      cleanMime.endsWith("+json") ||
      cleanMime.endsWith("+xml")
    ) {
      return "text";
    }
  }

  return "text";
}

export function inferMimeType(filePath: string, providedMime?: string): string {
  const ext = getExtension(filePath);
  const fromExt = ext ? EXT_TO_MIME[ext] : undefined;
  const cleanProvided = normalizeMime(providedMime);

  // For rich preview extensions, prefer the canonical MIME when providedMime is missing or generic.
  if (fromExt) {
    if (
      !cleanProvided ||
      cleanProvided === "application/octet-stream" ||
      cleanProvided === "binary/octet-stream" ||
      cleanProvided === "text/plain" ||
      cleanProvided.endsWith("/*")
    ) {
      return fromExt;
    }
    if (ext === ".svg") return "image/svg+xml";
  }

  if (cleanProvided && !cleanProvided.endsWith("/*")) {
    return cleanProvided;
  }

  return fromExt ?? "application/octet-stream";
}

function encodeUint8ToBase64(u8: Uint8Array): string {
  if (u8.length === 0) return "";
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    const sub = u8.subarray(i, i + chunk);
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j]);
    }
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(u8).toString("base64");
}

export function bytesToDataUrl(bytes: Uint8Array | number[] | string, mime: string): string {
  const safeMime = normalizeMime(mime) || "application/octet-stream";
  if (typeof bytes === "string") {
    if (bytes.startsWith("data:")) return bytes;
    const trimmed = bytes.trim();
    const stripped = trimmed.replace(/[\r\n]+/g, "");
    const looksLikeBase64 =
      stripped.length > 0 &&
      stripped.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(stripped) &&
      !trimmed.startsWith("<");
    if (looksLikeBase64) {
      return `data:${safeMime};base64,${stripped}`;
    }
    const encoded = new TextEncoder().encode(bytes);
    return `data:${safeMime};base64,${encodeUint8ToBase64(encoded)}`;
  }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `data:${safeMime};base64,${encodeUint8ToBase64(u8)}`;
}

export const HTML_PREVIEW_SANDBOX = "" as const;

export function sanitizeHtmlPreview(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2')
    .replace(/(href|src|action|formaction)\s*=\s*javascript:[^\s>]*/gi, '$1="#"');
}

export function getHtmlPreviewIframeProps(html: string, title = "HTML Preview") {
  return {
    sandbox: HTML_PREVIEW_SANDBOX,
    srcDoc: sanitizeHtmlPreview(html),
    title,
    referrerPolicy: "no-referrer" as const,
  };
}

export function isSourceToggleable(filePath: string, mime?: string): boolean {
  const kind = classifyPreviewKind(filePath, mime);
  if (kind === "markdown" || kind === "html") return true;
  if (getExtension(filePath) === ".svg" || normalizeMime(mime) === "image/svg+xml") return true;
  return false;
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function decodeBytesToText(bytes?: Uint8Array | number[] | string | null): string {
  if (!bytes) return "";
  if (typeof bytes === "string") return bytes;
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new TextDecoder().decode(u8);
  } catch {
    return "";
  }
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const combined = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = combined.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    }
    if (m[1] !== undefined) {
      nodes.push(<strong key={key++}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<code key={key++} className="tl-icode">{m[4]}</code>);
    } else if (m[5] !== undefined) {
      nodes.push(
        <a key={key++} href={m[7]} target="_blank" rel="noopener noreferrer">
          {m[6]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(<span key={key++}>{text.slice(last)}</span>);
  }
  return nodes;
}

function BuiltinMarkdownPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <div key={k++} className="tl-code-block">
          {lang && <div className="muted small">{lang}</div>}
          <pre><code>{codeLines.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      const lvl = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      if (lvl === 1) blocks.push(<h1 key={k++}>{content}</h1>);
      else if (lvl === 2) blocks.push(<h2 key={k++}>{content}</h2>);
      else blocks.push(<h3 key={k++}>{content}</h3>);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={k++} className="tl-quote">
          {renderInlineMarkdown(quoteLines.join(" "))}
        </blockquote>,
      );
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\|?[\s-:|]+\|/.test(lines[i + 1])) {
      const header = line.split("|").map((c) => c.trim()).filter(Boolean);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i].split("|").map((c) => c.trim()).filter(Boolean));
        i++;
      }
      blocks.push(
        <table key={k++} className="tl-table">
          <thead>
            <tr>{header.map((h, hi) => <th key={hi}>{renderInlineMarkdown(h)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInlineMarkdown(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={k++}>
          {items.map((it, idx) => <li key={idx}>{renderInlineMarkdown(it)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={k++}>
          {items.map((it, idx) => <li key={idx}>{renderInlineMarkdown(it)}</li>)}
        </ol>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    blocks.push(
      <p key={k++}>
        {renderInlineMarkdown(line)}
      </p>,
    );
    i++;
  }

  return <div>{blocks}</div>;
}

export interface FilePreviewProps {
  filePath: string;
  mime?: string;
  bytes?: Uint8Array | number[] | string | null;
  text?: string;
  size?: number;
  agentId?: string;
  renderMarkdown?: (text: string) => ReactNode;
}

export function FilePreview({
  filePath,
  mime,
  bytes,
  text,
  size,
  renderMarkdown,
}: FilePreviewProps) {
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setZoom("fit");
    setDimensions(null);
  }, [filePath]);

  const kind = classifyPreviewKind(filePath, mime);
  const resolvedMime = inferMimeType(filePath, mime);
  const fileName = (filePath || "").split(/[\\/]/).pop() || filePath;
  const byteSize =
    size ??
    (bytes instanceof Uint8Array
      ? bytes.length
      : Array.isArray(bytes)
        ? bytes.length
        : typeof bytes === "string"
          ? bytes.length
          : typeof text === "string"
            ? new TextEncoder().encode(text).length
            : 0);
  const sizeBadge = formatFileSize(byteSize);

  if (kind === "image") {
    const hasBytes =
      (bytes instanceof Uint8Array && bytes.length > 0) ||
      (Array.isArray(bytes) && bytes.length > 0) ||
      (typeof bytes === "string" && bytes.length > 0);
    const dataUrl = hasBytes
      ? bytesToDataUrl(bytes!, resolvedMime)
      : typeof text === "string" && text.length > 0
        ? bytesToDataUrl(text, resolvedMime)
        : "";

    const stepZoom = (delta: number) => {
      setZoom((prev) => {
        const base = prev === "fit" ? 100 : prev;
        return Math.max(25, Math.min(400, base + delta));
      });
    };

    return (
      <div
        data-testid="file-preview-image"
        style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", minHeight: 0 }}
      >
        <div className="files-toolbar" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className={`btn ghost small${zoom === "fit" ? " active" : ""}`}
            data-testid="file-preview-zoom-fit"
            onClick={() => setZoom("fit")}
          >
            Fit
          </button>
          <button
            type="button"
            className={`btn ghost small${zoom === 100 ? " active" : ""}`}
            data-testid="file-preview-zoom-100"
            onClick={() => setZoom(100)}
          >
            100%
          </button>
          <button
            type="button"
            className="btn ghost small"
            data-testid="file-preview-zoom-out"
            title="Zoom out"
            onClick={() => stepZoom(-25)}
          >
            -
          </button>
          <button
            type="button"
            className="btn ghost small"
            data-testid="file-preview-zoom-in"
            title="Zoom in"
            onClick={() => stepZoom(25)}
          >
            +
          </button>
          <span className="pill small" data-testid="file-preview-image-meta">
            {dimensions ? `${dimensions.width} × ${dimensions.height} · ` : ""}
            {sizeBadge}
            {typeof zoom === "number" ? ` · ${zoom}%` : ""}
          </span>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 180,
            overflow: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 12,
            borderRadius: 6,
            border: "1px solid var(--line)",
            background:
              "repeating-conic-gradient(#1a2030 0% 25%, #121722 0% 50%) 50% / 16px 16px",
          }}
        >
          {dataUrl ? (
            <img
              src={dataUrl}
              alt={fileName}
              onLoad={(e) => {
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (naturalWidth && naturalHeight) {
                  setDimensions({ width: naturalWidth, height: naturalHeight });
                }
              }}
              style={
                zoom === "fit"
                  ? { maxWidth: "100%", maxHeight: "70vh", objectFit: "contain" }
                  : { width: `${zoom}%`, maxWidth: "none" }
              }
            />
          ) : (
            <span className="muted small">Empty image</span>
          )}
        </div>
      </div>
    );
  }

  if (kind === "markdown") {
    const mdContent = text ?? decodeBytesToText(bytes);
    return (
      <div className="files-md" data-testid="file-preview-markdown">
        {renderMarkdown ? renderMarkdown(mdContent) : <BuiltinMarkdownPreview text={mdContent} />}
      </div>
    );
  }

  if (kind === "html") {
    const rawHtml = text ?? decodeBytesToText(bytes);
    const content = sanitizeHtmlPreview(rawHtml);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, height: "100%", minHeight: 320 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="muted small">Sandboxed HTML preview (scripts disabled)</span>
          <span className="pill small">{sizeBadge}</span>
        </div>
        <iframe
          data-testid="file-preview-html"
          sandbox=""
          srcDoc={content}
          title={fileName}
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            flex: 1,
            minHeight: 300,
            border: "1px solid var(--line)",
            borderRadius: 6,
            background: "#ffffff",
          }}
        />
      </div>
    );
  }

  if (kind === "pdf") {
    const dataUrl = bytes ? bytesToDataUrl(bytes, "application/pdf") : "";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, height: "100%", minHeight: 360 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small" style={{ fontFamily: "var(--mono)" }}>{fileName}</span>
          <span className="pill small" data-testid="file-preview-pdf-size">{sizeBadge}</span>
        </div>
        <iframe
          data-testid="file-preview-pdf"
          src={dataUrl}
          title={fileName}
          style={{
            width: "100%",
            flex: 1,
            minHeight: 340,
            border: "1px solid var(--line)",
            borderRadius: 6,
          }}
        />
      </div>
    );
  }

  if (kind === "audio") {
    const dataUrl = bytes ? bytesToDataUrl(bytes, resolvedMime) : "";
    return (
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small" style={{ fontFamily: "var(--mono)" }}>{fileName}</span>
          <span className="pill small">{resolvedMime} · {sizeBadge}</span>
        </div>
        <audio data-testid="file-preview-audio" controls src={dataUrl} style={{ width: "100%" }} />
      </div>
    );
  }

  if (kind === "video") {
    const dataUrl = bytes ? bytesToDataUrl(bytes, resolvedMime) : "";
    return (
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small" style={{ fontFamily: "var(--mono)" }}>{fileName}</span>
          <span className="pill small">{resolvedMime} · {sizeBadge}</span>
        </div>
        <video
          data-testid="file-preview-video"
          controls
          src={dataUrl}
          style={{ width: "100%", maxHeight: "65vh", borderRadius: 4, background: "#000" }}
        />
      </div>
    );
  }

  // Unsupported binary (or fallback)
  return (
    <div
      className="card"
      data-testid="file-preview-binary"
      style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12 }}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong className="small" style={{ fontFamily: "var(--mono)" }}>{fileName}</strong>
        <span className="pill small">{resolvedMime} · {sizeBadge}</span>
      </div>
      <div className="muted small">Binary file — preview not available</div>
    </div>
  );
}
