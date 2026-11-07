import { useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { FileExplorerDirectoryPayload } from "@getpaseo/client/internal/daemon-client";
import { VsFilesError, vsListDirectory, vsReadFile, vsWatchFile, vsWriteFile } from "./vsFiles";
import { DEMO } from "./demoFlag";
import { MarkdownRenderer } from "./Timeline";
import {
  FilePreview,
  bytesToDataUrl,
  classifyPreviewKind,
  inferMimeType,
  isSourceToggleable,
} from "./FilePreview";
import { normalizeRepoPath } from "./fileLinks";
import { baseName, isUnder, nameTaken, parentPath, remapPath, validateEntryName } from "./fileOps";
import { createEntry, deleteEntry, duplicateEntry, renameEntry } from "./paseoFiles";
import { useKeyBindings, usePref } from "./prefs";
import { bindingLabel } from "./keymap";
import { clientOnDaemonHost, ideUrl } from "./hunkUndo";
import { KEY_COMMAND_EVENT } from "./CommandPalette";
import { InlineEditBox, InlineEditReview, useInlineSession, useSessionContent } from "./InlineEdit";
import { clampRange, lineRangeFromOffsets, textLines, type LineRange } from "./inlineEditLogic";

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

function entriesToNodes(entries: Array<Pick<DirEntry, "name" | "path" | "kind"> & { size?: number }>): TreeNode[] {
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
const BIN_EXT = /\.(exe|dll|zip|gz|tgz|7z|rar|tar|woff2?|ttf|otf|class|jar|bin|so|dylib|o|node)$/i;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

function isBinaryBytes(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

type FileDialog =
  | { kind: "create"; entry: "file" | "directory"; parent: string }
  | { kind: "rename"; node: TreeNode }
  | { kind: "delete"; node: TreeNode };

type FileMenu = { x: number; y: number; node: TreeNode | null };

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
  const editModeRef = useRef(false);
  editModeRef.current = editMode;
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [readErr, setReadErr] = useState("");
  const [treeErr, setTreeErr] = useState("");
  const [sourceView, setSourceView] = useState(false);
  const [notice, setNotice] = useState("");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
  const [fileMime, setFileMime] = useState<string>("");
  const [fileSize, setFileSize] = useState<number | undefined>(undefined);
  const [revealDir, setRevealDir] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());
  const treeRef2 = useRef<TreeNode[]>([]);
  treeRef2.current = tree;
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const expandedRef = useRef<Set<string>>(expanded);
  expandedRef.current = expanded;
  const [menu, setMenu] = useState<FileMenu | null>(null);
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const [dialogName, setDialogName] = useState("");
  const [dialogErr, setDialogErr] = useState("");
  const [opBusy, setOpBusy] = useState(false);
  const [opErr, setOpErr] = useState("");
  const [ide] = usePref("app.openInIde");
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [inlineBox, setInlineBox] = useState<{ range: LineRange; top: number } | null>(null);
  const [inlineErr, setInlineErr] = useState("");
  const inlineSession = useInlineSession(cwd, openFile);
  const inlineKeys = bindingLabel(useKeyBindings().bindings, "inlineEdit");
  // The agent's edits land in the view as the session re-reads the file (not while you're editing).
  useSessionContent(inlineSession, (text, mtime) => {
    if (editMode || text === fileContent) return;
    setFileContent(text);
    setEditValue(text);
    setFileModifiedAt(mtime);
  });

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
        const dir = await vsListDirectory(cwd, "");
        if (!cancelled) { setTree(entriesToNodes(dir.entries)); setTreeErr(""); }
      } catch (e) {
        if (!cancelled && DEMO) setTree(DEMO_TREE);
        else if (!cancelled) setTreeErr(e instanceof Error ? e.message : String(e));
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
        const dir = await vsListDirectory(cwd, path);
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
      setInlineBox(null);
      setInlineErr("");
      setEditMode(false);
      setSaveErr("");
      setNotFound(false);
      setReadErr("");
      setNotice("");
      setImgUrl(null);
      setFileBytes(null);
      setFileMime("");
      setFileSize(undefined);
      setSourceView(line !== undefined); // a line target reads in Source; otherwise .md/.html/.svg renders
      if (normalizeRepoPath(path) === null) {
        // defense in depth: never ask the daemon for absolute / `..` paths
        setFileContent("");
        setNotFound(true);
        return;
      }
      const initialKind = classifyPreviewKind(path);
      const isImg = IMG_EXT.test(path) || initialKind === "image";
      const isMedia = initialKind === "pdf" || initialKind === "audio" || initialKind === "video";
      const cap = isImg ? MAX_IMG_BYTES : isMedia ? MAX_MEDIA_BYTES : MAX_TEXT_BYTES;
      const tooBig = (kb: number) => setNotice(`File too large to preview${kb ? ` (${kb} KB)` : ""}`);
      const known = findNode(treeRef2.current, path)?.size;
      if (BIN_EXT.test(path) && !isImg && !isMedia) {
        setFileContent("");
        setFileMime(inferMimeType(path));
        setFileSize(known);
        setImgUrl("binary");
        return;
      }
      if (known !== undefined && known > cap) {
        setFileContent("");
        tooBig(Math.round(known / 1024));
        return;
      }
      if (DEMO) {
        setFileContent(`// ${path}\n// DEMO mode — live content unavailable\n`);
        setFileMime(inferMimeType(path));
        setFileModifiedAt(new Date().toISOString());
        return;
      }
      try {
        const result = await vsReadFile(cwd, path, cap);
        const kb = Math.max(1, Math.round(result.bytes.length / 1024));
        if (result.bytes.length > cap) {
          setFileContent("");
          tooBig(kb);
          return;
        }
        const resolvedMime = inferMimeType(path, result.mime);
        const kind = classifyPreviewKind(path, resolvedMime);
        setFileBytes(result.bytes);
        setFileMime(resolvedMime);
        setFileSize(result.size ?? result.bytes.length);
        if (isImg) {
          const url = /\.svg$/i.test(path)
            ? `data:image/svg+xml;base64,${btoa(Array.from(result.bytes, (b) => String.fromCharCode(b)).join(""))}` // data: (not blob:) so "open in new tab" can't run embedded scripts on our origin
            : bytesToDataUrl(result.bytes, resolvedMime);
          if (!/\.svg$/i.test(path)) {
            setImgUrl(url);
            setFileContent("");
            return;
          }
        }
        if (kind === "pdf" || kind === "audio" || kind === "video") {
          setImgUrl(bytesToDataUrl(result.bytes, resolvedMime));
          setFileContent("");
          return;
        }
        if (kind === "binary" || isBinaryBytes(result.bytes)) {
          setFileMime(resolvedMime === "text/plain" ? "application/octet-stream" : resolvedMime);
          setImgUrl(`Binary file, ${kb} KB, not shown`);
          setFileContent("");
          return;
        }
        const text = stripAnsiForText(result.bytes);
        setFileContent(text);
        setEditValue(text);
        setFileModifiedAt(result.modifiedAt);

        // Live updates: the VS server's fs/watch long-poll. Not while editing (that would clobber the draft).
        unsubscribeRef.current = vsWatchFile(cwd, path, () => {
          if (editModeRef.current) return;
          vsReadFile(cwd, path, cap).then((r) => {
            if (editModeRef.current || r.bytes.length > cap || isBinaryBytes(r.bytes)) return;
            const next = stripAnsiForText(r.bytes);
            setFileBytes(r.bytes);
            setFileSize(r.size ?? r.bytes.length);
            setFileContent(next);
            setEditValue(next);
            setFileModifiedAt(r.modifiedAt);
          }, () => { /* gone or unreadable: keep what is shown */ });
        });
      } catch (e) {
        setFileContent("");
        if (e instanceof VsFilesError && e.tooLarge) tooBig(e.size ? Math.round(e.size / 1024) : 0);
        else if (e instanceof VsFilesError && !e.notFound) setReadErr(e.message);
        else setNotFound(true);
      }
    },
    [cwd],
  );

  useEffect(() => () => { if (imgUrl && imgUrl.startsWith("blob:")) URL.revokeObjectURL(imgUrl); }, [imgUrl]);

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
      // vsWriteFile resolves (doesn't throw) on a stale or failed write, so check the status.
      const r = await vsWriteFile(cwd, openFile, editValue, fileModifiedAt);
      if (r?.status === "conflict") {
        setSaveErr("Not saved: the file changed on disk since you opened it. Copy your edit, reopen the file and try again.");
        return;
      }
      if (r?.status === "error") {
        setSaveErr(`Not saved: ${r.error ?? "write failed"}`);
        return;
      }
      if (r?.modifiedAt) setFileModifiedAt(r.modifiedAt); // a second save in the same session stays fresh
      const encoded = new TextEncoder().encode(editValue);
      setFileBytes(encoded);
      setFileSize(encoded.length);
      setFileContent(editValue);
      setEditMode(false);
    } catch (e) {
      setSaveErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  // Re-list the root and every expanded folder (shallowest first so parents exist before children).
  const refreshTree = useCallback(async () => {
    if (DEMO) return;
    try {
      const dir = await vsListDirectory(cwd, "");
      setTree(entriesToNodes(dir.entries));
    } catch {
      return;
    }
    const open = [...expandedRef.current].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const p of open) await loadDir(p);
  }, [cwd, loadDir]);

  const closeViewerIf = (path: string) => {
    if (openFile && isUnder(openFile, path)) {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      setOpenFile(null);
      setEditMode(false);
    }
  };

  // Names already in `parent`; asks the daemon when the folder was never expanded (children not loaded).
  const siblingNames = async (parent: string): Promise<string[]> => {
    const list = parent ? findNode(tree, parent)?.children : tree;
    if (list) return list.map((n) => n.name);
    const dir = await vsListDirectory(cwd, parent);
    return dir.entries.map((e) => e.name);
  };

  const setExpandedBoth = (next: Set<string>) => {
    expandedRef.current = next;
    setExpanded(next);
  };

  const openDialog = (d: FileDialog) => {
    setMenu(null);
    setDialog(d);
    setDialogErr("");
    setDialogName(d.kind === "rename" ? d.node.name : "");
  };

  const submitDialog = async () => {
    if (!dialog || opBusy) return;
    setDialogErr("");
    setOpBusy(true);
    try {
      if (DEMO) throw new Error("File operations aren't available in demo mode");
      if (dialog.kind === "delete") {
        await deleteEntry(cwd, dialog.node.path);
        closeViewerIf(dialog.node.path);
        setExpandedBoth(new Set([...expandedRef.current].filter((p) => !isUnder(p, dialog.node.path))));
      } else {
        const name = dialogName.trim();
        const bad = validateEntryName(name);
        if (bad) throw new Error(bad);
        if (dialog.kind === "create") {
          if (nameTaken(await siblingNames(dialog.parent), name)) throw new Error(`"${name}" already exists here`);
          await createEntry(cwd, dialog.parent, name, dialog.entry);
          if (dialog.parent) setExpandedBoth(new Set([...expandedRef.current, dialog.parent]));
        } else if (name !== dialog.node.name) {
          if (nameTaken(await siblingNames(parentPath(dialog.node.path)), name, dialog.node.name)) {
            throw new Error(`"${name}" already exists here`);
          }
          const oldPath = dialog.node.path;
          const renamed = await renameEntry(cwd, oldPath, name);
          if (renamed) {
            setExpandedBoth(new Set([...expandedRef.current].map((p) => remapPath(p, oldPath, renamed))));
            if (openFile && isUnder(openFile, oldPath)) void openFileNode(remapPath(openFile, oldPath, renamed));
          } else {
            closeViewerIf(oldPath);
          }
        }
      }
      setDialog(null);
      await refreshTree();
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOpBusy(false);
    }
  };

  const duplicateNode = async (node: TreeNode) => {
    setMenu(null);
    setOpErr("");
    try {
      if (DEMO) throw new Error("File operations aren't available in demo mode");
      await duplicateEntry(cwd, node.path);
      await refreshTree();
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Download = read the bytes over the existing socket and hand them to the browser. The daemon's
  // requestDownloadToken is an opaque token for its own HTTP route, which VS doesn't proxy.
  const downloadNode = async (node: TreeNode) => {
    setMenu(null);
    setOpErr("");
    try {
      if (DEMO) throw new Error("Download isn't available in demo mode");
      const tooBig = "File too large to download (over 25 MB)";
      if (node.size !== undefined && node.size > MAX_DOWNLOAD_BYTES) throw new Error(tooBig);
      const r = await vsReadFile(cwd, node.path, MAX_DOWNLOAD_BYTES);
      if (r.bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(tooBig);
      const url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.mime || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = node.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Folder rows create inside themselves; file rows create next to themselves; no row = repo root.
  const createParentFor = (node: TreeNode | null) => (!node ? "" : node.kind === "directory" ? node.path : parentPath(node.path));

  useEffect(() => {
    if (!dialog || opBusy) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDialog(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, opBusy]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const isMd = !!openFile && /\.(md|markdown)$/i.test(openFile);
  const previewKind = openFile ? classifyPreviewKind(openFile, fileMime || undefined) : "text";
  const canTogglePreview = !!openFile && isSourceToggleable(openFile, fileMime || undefined);

  // Ctrl+K (rebindable, scoped to the Files editor): the selected lines → the inline edit prompt box.
  const openInlineEdit = () => {
    setInlineErr("");
    const viewer = viewerRef.current;
    if (!openFile || !viewer || notFound || readErr || notice || imgUrl) return;
    const below = (r: DOMRect) => r.bottom - viewer.getBoundingClientRect().top + 4;
    if (editMode) {
      const ta = textareaRef.current;
      if (!ta) return;
      if (editValue !== fileContent) { setInlineErr("Save or cancel your edit first: inline edit works on the saved file."); return; }
      const range = lineRangeFromOffsets(editValue, ta.selectionStart, ta.selectionEnd);
      const st = getComputedStyle(ta);
      const lh = parseFloat(st.lineHeight) || 1.4 * parseFloat(st.fontSize) || 16;
      const taTop = ta.getBoundingClientRect().top - viewer.getBoundingClientRect().top;
      const top = taTop + parseFloat(st.paddingTop || "0") + range.to * lh - ta.scrollTop + 4;
      setInlineBox({ range, top: Math.max(taTop, Math.min(top, taTop + ta.clientHeight - 8)) });
      return;
    }
    if ((isMd && !sourceView) || (canTogglePreview && !sourceView)) { setInlineErr("Switch to Source to select lines."); return; }
    const sel = window.getSelection();
    const code = codeRef.current;
    if (!code || !sel || sel.rangeCount === 0) { setInlineErr("Select some lines first."); return; }
    const r = sel.getRangeAt(0);
    const lineOf = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>("[data-line]");
    const a = code.contains(r.startContainer) ? lineOf(r.startContainer) : null;
    let b = code.contains(r.endContainer) ? lineOf(r.endContainer) : null;
    if (!a || !b) { setInlineErr("Select some lines first."); return; }
    // A triple-click ends at offset 0 of the next line: that line isn't part of the selection.
    if (!r.collapsed && r.endOffset === 0 && b !== a && b.previousElementSibling instanceof HTMLElement) b = b.previousElementSibling;
    const range = clampRange({ from: Number(a.dataset.line), to: Number(b.dataset.line) }, textLines(fileContent).length);
    const last = lineRefs.current.get(range.to);
    setInlineBox({ range, top: last ? below(last.getBoundingClientRect()) : 40 });
  };
  const openInlineEditRef = useRef(openInlineEdit);
  openInlineEditRef.current = openInlineEdit;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; target: HTMLElement | null }>).detail;
      if (d?.id === "inlineEdit" && d.target && viewerRef.current?.contains(d.target)) openInlineEditRef.current();
    };
    window.addEventListener(KEY_COMMAND_EVENT, on);
    return () => window.removeEventListener(KEY_COMMAND_EVENT, on);
  }, []);
  const closeInlineBox = () => {
    setInlineBox(null);
    (editMode ? textareaRef.current : codeRef.current)?.focus();
  };
  const inlineRange = inlineBox?.range ?? (inlineSession?.phase === "pending" ? inlineSession.range : null);

  return (
    <div className="files-panel" data-testid="files-panel">
      <div className="files-tree" ref={treeRef} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }); }}>
        <div className="files-toolbar">
          <button className="btn ghost small" data-testid="files-new-file-btn" onClick={() => openDialog({ kind: "create", entry: "file", parent: "" })}>+ File</button>
          <button className="btn ghost small" data-testid="files-new-folder-btn" onClick={() => openDialog({ kind: "create", entry: "directory", parent: "" })}>+ Folder</button>
          <button className="btn ghost small" data-testid="files-refresh-btn" title="Refresh tree" onClick={() => void refreshTree()}>↻</button>
        </div>
        {opErr && <div className="stat-alert small" data-testid="files-op-error">{opErr}</div>}
        {loading && <div className="muted small">Loading…</div>}
        {!loading && treeErr && <div className="muted small" data-testid="files-tree-error">{treeErr}</div>}
        {renderNodes(tree, expanded, toggleDir, openFileNode, openFile, (e, node) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, node });
        })}
      </div>
      {menu && (
        <div
          className="ctx-menu files-ctx-menu"
          data-testid="files-ctx-menu"
          role="menu"
          style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 170)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 220)) }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button role="menuitem" data-testid="files-menu-new-file" onClick={() => openDialog({ kind: "create", entry: "file", parent: createParentFor(menu.node) })}>New file…</button>
          <button role="menuitem" data-testid="files-menu-new-folder" onClick={() => openDialog({ kind: "create", entry: "directory", parent: createParentFor(menu.node) })}>New folder…</button>
          {menu.node && (
            <>
              <button role="menuitem" data-testid="files-menu-rename" onClick={() => openDialog({ kind: "rename", node: menu.node! })}>Rename…</button>
              <button role="menuitem" data-testid="files-menu-duplicate" onClick={() => void duplicateNode(menu.node!)}>Duplicate</button>
              {menu.node.kind === "file" && (
                <button role="menuitem" data-testid="files-menu-download" onClick={() => void downloadNode(menu.node!)}>Download</button>
              )}
              <button role="menuitem" className="bad" data-testid="files-menu-delete" onClick={() => openDialog({ kind: "delete", node: menu.node! })}>Delete…</button>
            </>
          )}
        </div>
      )}
      {dialog && (
        <div className="modal-back" onMouseDown={() => !opBusy && setDialog(null)}>
          <div className="modal files-dialog" data-testid="files-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                {dialog.kind === "delete" ? "Delete" : dialog.kind === "rename" ? "Rename" : dialog.entry === "file" ? "New file" : "New folder"}
              </span>
            </div>
            <div className="modal-body">
              {dialog.kind === "delete" ? (
                <div data-testid="files-delete-confirm">
                  Delete <b>{dialog.node.path}</b>
                  {dialog.node.kind === "directory" ? " and everything inside it" : ""}? This can't be undone.
                </div>
              ) : (
                <>
                  <div className="muted small files-dialog-where">
                    {dialog.kind === "create" ? `in ${dialog.parent || "repo root"}` : `${baseName(dialog.node.path)} in ${parentPath(dialog.node.path) || "repo root"}`}
                  </div>
                  <input
                    autoFocus
                    data-testid="files-dialog-input"
                    value={dialogName}
                    placeholder={dialog.kind === "create" && dialog.entry === "directory" ? "folder-name" : "file-name.ext"}
                    onChange={(e) => setDialogName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void submitDialog(); }}
                    onFocus={(e) => { if (dialog.kind === "rename") e.currentTarget.select(); }}
                    spellCheck={false}
                  />
                </>
              )}
            </div>
            <div className="modal-foot">
              {dialogErr && <span className="stat-alert small" data-testid="files-dialog-error">{dialogErr}</span>}
              <button className="btn ghost" onClick={() => setDialog(null)} disabled={opBusy}>Cancel</button>
              <button
                className={`btn ${dialog.kind === "delete" ? "bad" : "ok"}`}
                data-testid="files-dialog-confirm"
                onClick={() => void submitDialog()}
                disabled={opBusy}
              >
                {opBusy ? "Working…" : dialog.kind === "delete" ? "Delete" : dialog.kind === "rename" ? "Rename" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
      {openFile && (
        <div className="files-viewer" ref={viewerRef} data-keyscope="files-editor">
          <div className="files-viewer-header">
            <span className="muted small">{openFile}</span>
            {ide !== "none" && (DEMO || clientOnDaemonHost(location.hostname)) && cwd && (() => {
              const atTarget = targetLine && openFile === (targetFile ? normalizeRepoPath(targetFile)?.replace(/\/+$/, "") : null);
              const href = ideUrl(ide, cwd, openFile, atTarget ? targetLine! : 1);
              return href && (
                <a className="btn ghost small" data-testid="files-open-ide" href={href} title="Open in your IDE at this line">IDE ↗</a>
              );
            })()}
            {(isMd || canTogglePreview) && !notFound && !readErr && !notice && !imgUrl && !editMode && (
              <button
                className="btn ghost small"
                data-testid="files-source-btn"
                onClick={() => setSourceView((v) => !v)}
              >
                {sourceView ? "Preview" : "Source"}
              </button>
            )}
            {!editMode && !notFound && !readErr && !notice && !imgUrl && (
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
          {inlineErr && <div className="stat-alert small" data-testid="inline-edit-hint">{inlineErr}</div>}
          {inlineSession && <InlineEditReview session={inlineSession} />}
          {inlineBox && (
            <InlineEditBox cwd={cwd} path={openFile} range={inlineBox.range} viewText={fileContent} top={inlineBox.top} onClose={closeInlineBox} />
          )}
          {editMode ? (
            <textarea
              ref={textareaRef}
              data-testid="files-editor-textarea"
              className="files-editor"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              spellCheck={false}
            />
          ) : readErr ? (
            <div className="muted small" data-testid="files-read-error">{readErr}</div>
          ) : notFound ? (
            <div className="muted small" data-testid="files-not-found">File not found: {openFile}</div>
          ) : notice ? (
            <div className="muted small" data-testid="files-notice">{notice}</div>
          ) : imgUrl || (isMd && !sourceView) || (canTogglePreview && !sourceView) ? (
            <div
              className="files-md"
              data-testid={
                previewKind === "image"
                  ? "files-image-view"
                  : isMd
                    ? "files-md-view"
                    : "files-preview-view"
              }
            >
              <FilePreview
                filePath={openFile}
                mime={fileMime || undefined}
                bytes={fileBytes}
                text={fileContent}
                size={fileSize}
                agentId={agent.id}
                renderMarkdown={(md) => <MarkdownRenderer text={md} agentId={agent.id} doc />}
              />
            </div>
          ) : (
            <div className="files-code" data-testid="files-code-view" ref={codeRef} tabIndex={0} title={inlineKeys ? `Select lines and press ${inlineKeys} to ask an agent to edit them` : undefined}>
              {fileContent.split("\n").map((line, i) => {
                const lineNum = i + 1;
                const isHighlighted = targetLine === lineNum && openFile === (targetFile ? normalizeRepoPath(targetFile)?.replace(/\/+$/, "") : null);
                return (
                  <div
                    key={i}
                    className={`files-line${isHighlighted ? " highlighted" : ""}${inlineRange && lineNum >= inlineRange.from && lineNum <= inlineRange.to ? " inline-range" : ""}`}
                    data-testid={isHighlighted ? "files-highlighted-line" : undefined}
                    data-line={lineNum}
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
  onMenu: (e: React.MouseEvent, node: TreeNode) => void,
  depth = 0,
): React.ReactNode {
  return nodes.map((n) => (
    <div key={n.path} style={{ paddingLeft: depth * 12 }}>
      {n.kind === "directory" ? (
        <>
          <div className="files-row" onContextMenu={(e) => onMenu(e, n)}>
            <button
              className={`files-tree-entry dir${expanded.has(n.path) ? " open" : ""}`}
              data-testid="files-dir-row"
              data-path={n.path}
              onClick={() => onToggle(n.path)}
            >
              <span className="files-icon">{expanded.has(n.path) ? "▾" : "▸"}</span>
              {n.name}
            </button>
            <button className="files-row-more" data-testid="files-row-more" aria-label={`Actions for ${n.name}`} onClick={(e) => onMenu(e, n)}>⋯</button>
          </div>
          {expanded.has(n.path) && n.children
            ? renderNodes(n.children, expanded, onToggle, onOpen, openFile, onMenu, depth + 1)
            : null}
        </>
      ) : (
        <div className="files-row" onContextMenu={(e) => onMenu(e, n)}>
          <button
            className={`files-tree-entry file${n.path === openFile ? " active" : ""}`}
            data-testid="files-file-row"
            data-path={n.path}
            onClick={() => onOpen(n.path)}
          >
            <span className="files-icon">📄</span>
            {n.name}
          </button>
          <button className="files-row-more" data-testid="files-row-more" aria-label={`Actions for ${n.name}`} onClick={(e) => onMenu(e, n)}>⋯</button>
        </div>
      )}
    </div>
  ));
}
