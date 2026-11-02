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
  const [revealDir, setRevealDir] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());
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
      // absolute / `..` / drive paths never reach the daemon
      setOpenFile(targetFile);
      setNotFound(true);
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
      setSourceView(line !== undefined); // a line target reads in Source; otherwise .md renders
      if (normalizeRepoPath(path) === null) {
        // defense in depth: never ask the daemon for absolute / `..` paths
        setFileContent("");
        setNotFound(true);
        return;
      }
      if (DEMO) {
        setFileContent(`// ${path}\n// DEMO mode — live content unavailable\n`);
        setFileModifiedAt(new Date().toISOString());
        return;
      }
      try {
        const result = await daemonClient.readFile(cwd, path);
        const text = stripAnsiForText(result.bytes);
        setFileContent(text);
        setEditValue(text);
        setFileModifiedAt(result.modifiedAt);

        // Subscribe to live updates
        const sub = daemonClient.observeFile({ cwd, path });
        unsubscribeRef.current = () => { sub.release().catch(() => {}); };
      } catch {
        setFileContent("");
        setNotFound(true);
      }
    },
    [cwd],
  );

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
      await daemonClient.writeFile({
        cwd,
        path: openFile,
        content: editValue,
        expectedModifiedAt: fileModifiedAt,
      });
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
            {isMd && !notFound && !editMode && (
              <button
                className="btn ghost small"
                data-testid="files-source-btn"
                onClick={() => setSourceView((v) => !v)}
              >
                {sourceView ? "Rendered" : "Source"}
              </button>
            )}
            {!editMode && !notFound && (
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
