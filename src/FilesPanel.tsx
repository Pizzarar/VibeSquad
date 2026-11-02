import { useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { FileExplorerDirectoryPayload } from "@getpaseo/client/internal/daemon-client";
import { daemonClient, DEMO } from "./paseo";
import { MarkdownRenderer } from "./Timeline";
import { normalizeRepoPath } from "./fileLinks";

type DirEntry = FileExplorerDirectoryPayload["entries"][number];

type TreeNode = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  children?: TreeNode[] | null; // null = not yet loaded
};

const DEMO_TREE: TreeNode[] = [
  { name: "src", path: "src", kind: "directory", children: null },
  { name: "README.md", path: "README.md", kind: "file" },
  { name: "package.json", path: "package.json", kind: "file" },
];

const DEMO_CHILDREN: TreeNode[] = [
  { name: "App.tsx", path: "src/App.tsx", kind: "file" },
  { name: "AgentDrawer.tsx", path: "src/AgentDrawer.tsx", kind: "file" },
];

function entriesToNodes(entries: DirEntry[]): TreeNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    kind: e.kind,
    size: e.kind === "file" ? e.size : undefined,
    children: e.kind === "directory" ? null : undefined,
  }));
}

function stripAnsiForText(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes).replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
  } catch {
    return "";
  }
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const BIN_EXT = /\.(exe|dll|zip|gz|tgz|7z|rar|tar|pdf|woff2?|ttf|otf|mp[34]|mov|wav|class|jar|bin|so|dylib|o|node)$/i;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMG_BYTES = 5 * 1024 * 1024;

function isBinaryBytes(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const f = findNode(n.children, path);
      if (f) return f;
    }
  }
  return undefined;
}

export function FilesPanel({
  agent,
  targetFile,
  targetLine,
  targetNonce,
}: {
  agent: PaseoAgent;
  targetFile?: string | null;
  targetLine?: number | null;
  targetNonce?: number;
}) {
  const cwd = agent.cwd ?? "";
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [fileModifiedAt, setFileModifiedAt] = useState<string>("");
  const [editMode, setEditMode] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [sourceView, setSourceView] = useState(false);
  const [notice, setNotice] = useState("");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [revealDir, setRevealDir] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());
  const treeRef2 = useRef<TreeNode[]>([]);
  treeRef2.current = tree;
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Load root directory on mount / cwd change
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        if (DEMO) {
          setTree(DEMO_TREE);
          return;
        }
        const dir = await daemonClient.listDirectory(cwd, "");
        if (!cancelled) setTree(entriesToNodes(dir.entries));
      } catch {
        if (!cancelled && DEMO) setTree(DEMO_TREE);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Auto-open targetFile
  useEffect(() => {
    if (!targetFile) return;
    const clean = normalizeRepoPath(targetFile);
    if (clean === null) {
      // absolute / `..` / drive paths never reach the daemon; openFileNode resets all view state
      void openFileNode(targetFile);
      return;
    }
    if (clean.endsWith("/")) void revealFolder(clean.replace(/\/+$/, ""));
    else openFileNode(clean, targetLine ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFile, targetLine, targetNonce]);

  // Scroll to targetLine after file opens
  useEffect(() => {
    if (!targetLine || !openFile) return;
    const el = lineRefs.current.get(targetLine);
    if (el) el.scrollIntoView({ block: "center" });
  }, [openFile, targetLine, fileContent, sourceView]);

  const loadDir = useCallback(
    async (path: string) => {
      if (DEMO) {
        setTree((prev) => updateNode(prev, path, DEMO_CHILDREN));
        return;
      }
      try {
        const dir = await daemonClient.listDirectory(cwd, path);
        setTree((prev) => updateNode(prev, path, entriesToNodes(dir.entries)));
      } catch {
        // silently ignore
      }
    },
    [cwd],
  );

  // Expand every ancestor of a folder (loading each level in turn), then scroll it into view.
  const revealFolder = useCallback(
    async (dir: string) => {
      const parts = dir.split("/").filter(Boolean);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        setExpanded((prev) => new Set([...prev, acc]));
        await loadDir(acc);
      }
      setRevealDir(dir);
    },
    [loadDir],
  );

  useEffect(() => {
    if (!revealDir) return;
    const rows = treeRef.current?.querySelectorAll<HTMLElement>("[data-path]");
    const el = Array.from(rows ?? []).find((r) => r.dataset.path === revealDir);
    if (el) {
      el.scrollIntoView({ block: "center" });
      setRevealDir(null);
    }
  }, [revealDir, tree]);

  const openFileNode = useCallback(
    async (path: string, line?: number) => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      setOpenFile(path);
      setEditMode(false);
      setSaveErr("");
      setNotFound(false);
      setNotice("");
      setImgUrl(null);
      setSourceView(line !== undefined); // a line target reads in Source; otherwise .md renders
      if (normalizeRepoPath(path) === null) {
        // defense in depth: never ask the daemon for absolute / `..` paths
        setFileContent("");
        setNotFound(true);
        return;
      }
      const isImg = IMG_EXT.test(path);
      const cap = isImg ? MAX_IMG_BYTES : MAX_TEXT_BYTES;
      const tooBig = (kb: number) => setNotice(`File too large to preview${kb ? ` (${kb} KB)` : ""}`);
      if (BIN_EXT.test(path) && !isImg) {
        setFileContent("");
        setNotice("Binary file, not shown");
        return;
      }
      const known = findNode(treeRef2.current, path)?.size;
      if (known !== undefined && known > cap) {
        setFileContent("");
        tooBig(Math.round(known / 1024));
        return;
      }
      if (DEMO) {
        setFileContent(`// ${path}\n// DEMO mode — live content unavailable\n`);
        setFileModifiedAt(new Date().toISOString());
        return;
      }
      try {
        const result = await daemonClient.readFile(cwd, path, undefined, cap + 1);
        const kb = Math.max(1, Math.round(result.bytes.length / 1024));
        if (result.bytes.length > cap) {
          setFileContent("");
          tooBig(kb);
          return;
        }
        if (isImg) {
          const url = /\.svg$/i.test(path)
            ? `data:image/svg+xml;base64,${btoa(Array.from(result.bytes, (b) => String.fromCharCode(b)).join(""))}` // data: (not blob:) so "open in new tab" can't run embedded scripts on our origin
            : URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: result.mime || "image/*" }));
          setImgUrl(url);
          setFileContent("");
          return;
        }
        if (isBinaryBytes(result.bytes)) {
          setFileContent("");
          setNotice(`Binary file, ${kb} KB, not shown`);
          return;
        }
        const text = stripAnsiForText(result.bytes);
        setFileContent(text);
        setEditValue(text);
        setFileModifiedAt(result.modifiedAt);

        // Subscribe to live updates
        const sub = daemonClient.observeFile({ cwd, path });
        unsubscribeRef.current = () => { sub.release().catch(() => {}); };
      } catch (e) {
        setFileContent("");
        if (/too large|max.?bytes|exceeds/i.test(String(e))) tooBig(0);
        else setNotFound(true);
      }
    },
    [cwd],
  );

  useEffect(() => () => { if (imgUrl) URL.revokeObjectURL(imgUrl); }, [imgUrl]);

  useEffect(
    () => () => {
      unsubscribeRef.current?.();
    },
    [],
  );

  const toggleDir = useCallback(
    async (path: string) => {
      const isOpen = expanded.has(path);
      if (isOpen) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } else {
        setExpanded((prev) => new Set([...prev, path]));
        await loadDir(path);
      }
    },
    [expanded, loadDir],
  );

  const saveFile = async () => {
    if (!openFile) return;
    setSaving(true);
    setSaveErr("");
    try {
      const res = await daemonClient.writeFile({
        cwd,
        path: openFile,
        content: editValue,
        expectedModifiedAt: fileModifiedAt,
      });
      // writeFile resolves (doesn't throw) on a stale or failed write, so check the status.
      const r = res as { status?: string; error?: string; modifiedAt?: string };
      if (r?.status === "conflict") {
        setSaveErr("Not saved: the file changed on disk since you opened it. Copy your edit, reopen the file and try again.");
        return;
      }
      if (r?.status === "error") {
        setSaveErr(`Not saved: ${r.error ?? "write failed"}`);
        return;
      }
      if (r?.modifiedAt) setFileModifiedAt(r.modifiedAt); // a second save in the same session stays fresh
      setFileContent(editValue);
      setEditMode(false);
    } catch (e) {
      setSaveErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const isMd = !!openFile && /\.(md|markdown)$/i.test(openFile);

  return (
    <div className="files-panel" data-testid="files-panel">
      <div className="files-tree" ref={treeRef}>
        {loading && <div className="muted small">Loading…</div>}
        {renderNodes(tree, expanded, toggleDir, openFileNode, openFile)}
      </div>
      {openFile && (
        <div className="files-viewer">
          <div className="files-viewer-header">
            <span className="muted small">{openFile}</span>
            {isMd && !notFound && !notice && !editMode && (
              <button
                className="btn ghost small"
                data-testid="files-source-btn"
                onClick={() => setSourceView((v) => !v)}
              >
                {sourceView ? "Rendered" : "Source"}
              </button>
            )}
            {!editMode && !notFound && !notice && !imgUrl && (
              <button
                className="btn ghost small"
                data-testid="files-edit-btn"
                onClick={() => {
                  setEditValue(fileContent);
                  setEditMode(true);
                }}
              >
                Edit
              </button>
            )}
            {editMode && (
              <>
                <button
                  className="btn ok small"
                  data-testid="files-save-btn"
                  onClick={() => void saveFile()}
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button className="btn ghost small" onClick={() => setEditMode(false)}>
                  Cancel
                </button>
              </>
            )}
          </div>
          {saveErr && <div className="stat-alert small">{saveErr}</div>}
          {editMode ? (
            <textarea
              data-testid="files-editor-textarea"
              className="files-editor"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              spellCheck={false}
            />
          ) : notFound ? (
            <div className="muted small" data-testid="files-not-found">File not found: {openFile}</div>
          ) : imgUrl ? (
            <div className="files-md" data-testid="files-image-view">
              <img src={imgUrl} alt={openFile} style={{ maxWidth: "100%" }} />
            </div>
          ) : notice ? (
            <div className="muted small" data-testid="files-notice">{notice}</div>
          ) : isMd && !sourceView ? (
            <div className="files-md" data-testid="files-md-view">
              <MarkdownRenderer text={fileContent} agentId={agent.id} doc />
            </div>
          ) : (
            <div className="files-code" data-testid="files-code-view">
              {fileContent.split("\n").map((line, i) => {
                const lineNum = i + 1;
                const isHighlighted = targetLine === lineNum && openFile === (targetFile ? normalizeRepoPath(targetFile)?.replace(/\/+$/, "") : null);
                return (
                  <div
                    key={i}
                    className={`files-line${isHighlighted ? " highlighted" : ""}`}
                    data-testid={isHighlighted ? "files-highlighted-line" : undefined}
                    ref={(el) => {
                      if (el) lineRefs.current.set(lineNum, el);
                      else lineRefs.current.delete(lineNum);
                    }}
                  >
                    <span className="files-lineno">{lineNum}</span>
                    <span className="files-linetext">{line}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function updateNode(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === path) return { ...n, children };
    if (n.children) return { ...n, children: updateNode(n.children, path, children) };
    return n;
  });
}

function renderNodes(
  nodes: TreeNode[],
  expanded: Set<string>,
  onToggle: (p: string) => void,
  onOpen: (p: string) => void,
  openFile: string | null,
  depth = 0,
): React.ReactNode {
  return nodes.map((n) => (
    <div key={n.path} style={{ paddingLeft: depth * 12 }}>
      {n.kind === "directory" ? (
        <>
          <button
            className={`files-tree-entry dir${expanded.has(n.path) ? " open" : ""}`}
            data-testid="files-dir-row"
            data-path={n.path}
            onClick={() => onToggle(n.path)}
          >
            <span className="files-icon">{expanded.has(n.path) ? "▾" : "▸"}</span>
            {n.name}
          </button>
          {expanded.has(n.path) && n.children
            ? renderNodes(n.children, expanded, onToggle, onOpen, openFile, depth + 1)
            : null}
        </>
      ) : (
        <button
          className={`files-tree-entry file${n.path === openFile ? " active" : ""}`}
          data-testid="files-file-row"
          onClick={() => onOpen(n.path)}
        >
          <span className="files-icon">📄</span>
          {n.name}
        </button>
      )}
    </div>
  ));
}
