import { useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { FileExplorerDirectoryPayload } from "@getpaseo/client/internal/daemon-client";
import { daemonClient, DEMO } from "./paseo";

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
}: {
  agent: PaseoAgent;
  targetFile?: string | null;
  targetLine?: number | null;
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
    openFileNode(targetFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFile]);

  // Scroll to targetLine after file opens
  useEffect(() => {
    if (!targetLine || !openFile) return;
    const el = lineRefs.current.get(targetLine);
    if (el) el.scrollIntoView({ block: "center" });
  }, [openFile, targetLine, fileContent]);

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

  const openFileNode = useCallback(
    async (path: string) => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      setOpenFile(path);
      setEditMode(false);
      setSaveErr("");
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
        setFileContent("// Could not read file");
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

  return (
    <div className="files-panel" data-testid="files-panel">
      <div className="files-tree">
        {loading && <div className="muted small">Loading…</div>}
        {renderNodes(tree, expanded, toggleDir, openFileNode, openFile)}
      </div>
      {openFile && (
        <div className="files-viewer">
          <div className="files-viewer-header">
            <span className="muted small">{openFile}</span>
            {!editMode && (
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
          ) : (
            <div className="files-code" data-testid="files-code-view">
              {fileContent.split("\n").map((line, i) => {
                const lineNum = i + 1;
                const isHighlighted = targetLine === lineNum && openFile === targetFile;
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
