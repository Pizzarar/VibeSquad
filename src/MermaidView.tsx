import { createElement, type ReactNode, useEffect, useMemo, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MermaidKind = "flowchart" | "sequence" | "state" | "unknown";

export type FlowDirection = "TD" | "TB" | "BT" | "RL" | "LR";

export type NodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "diamond"
  | "circle"
  | "state-start"
  | "state-end";

export interface MermaidNode {
  id: string;
  label: string;
  shape: NodeShape;
  subgraphId?: string;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label: string;
  style: "solid" | "dotted" | "thick";
  arrow: boolean;
  cross?: boolean;
  openArrow?: boolean;
}

export interface MermaidSubgraph {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface SequenceParticipant {
  id: string;
  label: string;
  actor: boolean;
}

export interface SequenceMessage {
  from: string;
  to: string;
  text: string;
  dashed: boolean;
  arrow: "filled" | "open" | "cross";
}

export type ParseMermaidResult =
  | {
      ok: true;
      kind: "flowchart" | "sequence" | "state";
      direction: FlowDirection;
      nodeCount: number;
      edgeCount: number;
      nodes: MermaidNode[];
      edges: MermaidEdge[];
      subgraphs: MermaidSubgraph[];
      participants: SequenceParticipant[];
      messages: SequenceMessage[];
    }
  | {
      ok: false;
      error: string;
      kind?: MermaidKind;
    };

export type RenderMermaidResult =
  | {
      ok: true;
      svg: string;
      kind: "flowchart" | "sequence" | "state";
      nodeCount: number;
      edgeCount: number;
    }
  | {
      ok: false;
      error: string;
    };

// ─── XML & SVG Security Helpers ───────────────────────────────────────────────

export function escapeXml(raw: string): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sanitizeSvg(svg: string): string {
  return String(svg ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

// ─── Kind Detection ───────────────────────────────────────────────────────────

function stripFrontmatterAndComments(code: string): string[] {
  const rawLines = String(code ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let idx = 0;
  while (idx < rawLines.length && rawLines[idx].trim() === "") idx++;
  if (rawLines[idx]?.trim() === "---") {
    idx++;
    while (idx < rawLines.length && rawLines[idx].trim() !== "---") idx++;
    if (idx < rawLines.length) idx++;
  }
  const out: string[] = [];
  for (; idx < rawLines.length; idx++) {
    const trimmed = rawLines[idx].trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    out.push(trimmed);
  }
  return out;
}

export function detectMermaidKind(code: string): MermaidKind {
  if (typeof code !== "string" || !code.trim()) return "unknown";
  const lines = stripFrontmatterAndComments(code);
  if (lines.length === 0) return "unknown";
  const first = lines[0];
  if (/^(?:flowchart|graph)(?:\s+(?:TD|TB|BT|RL|LR))?(?:\s*;.*|\s*)$/i.test(first)) {
    return "flowchart";
  }
  if (/^sequenceDiagram(?:\s*;.*|\s*)$/i.test(first)) {
    return "sequence";
  }
  if (/^stateDiagram(?:-v2)?(?:\s*;.*|\s*)$/i.test(first)) {
    return "state";
  }
  return "unknown";
}

// ─── Statement Splitter & Low-Level Scanner ───────────────────────────────────

function splitStatements(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    let cur = "";
    let quote: string | null = null;
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        cur += ch;
        if (ch === quote && line[i - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "%" && line[i + 1] === "%") {
        break; // inline %% comment
      }
      if (ch === "[" || ch === "(" || ch === "{") {
        depth++;
        cur += ch;
        continue;
      }
      if (ch === "]" || ch === ")" || ch === "}") {
        depth = Math.max(0, depth - 1);
        cur += ch;
        continue;
      }
      if (ch === ";" && depth === 0) {
        if (cur.trim()) result.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) result.push(cur.trim());
  }
  return result;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function scanBalanced(
  s: string,
  startPos: number,
  openSeq: string,
  closeSeq: string,
): { content: string; nextPos: number } | null {
  if (!s.startsWith(openSeq, startPos)) return null;
  let i = startPos + openSeq.length;
  let quote: string | null = null;
  const openCh = openSeq[openSeq.length - 1];
  const closeCh = closeSeq[0];
  let nested = 0;

  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (nested === 0 && s.startsWith(closeSeq, i)) {
      return {
        content: s.slice(startPos + openSeq.length, i),
        nextPos: i + closeSeq.length,
      };
    }
    if (ch === openCh) nested++;
    else if (ch === closeCh && nested > 0) nested--;
    i++;
  }
  return null;
}

interface ParsedNodeToken {
  id: string;
  label: string;
  shape: NodeShape;
  explicit: boolean;
  nextPos: number;
}

function parseNodeToken(s: string, pos: number): ParsedNodeToken | null {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  if (pos >= s.length) return null;

  const idMatch = s.slice(pos).match(/^([A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)/);
  if (!idMatch) return null;
  const id = idMatch[1];
  let cur = pos + id.length;

  let shape: NodeShape = "rect";
  let label = id;
  let explicit = false;

  const shapeDelims: Array<{ open: string; close: string; shape: NodeShape }> = [
    { open: "([", close: "])", shape: "stadium" },
    { open: "((", close: "))", shape: "circle" },
    { open: "[[", close: "]]", shape: "rect" },
    { open: "[(", close: ")]", shape: "rect" },
    { open: "{{", close: "}}", shape: "diamond" },
    { open: "[", close: "]", shape: "rect" },
    { open: "(", close: ")", shape: "round" },
    { open: "{", close: "}", shape: "diamond" },
    { open: ">", close: "]", shape: "rect" },
  ];

  for (const d of shapeDelims) {
    if (s.startsWith(d.open, cur)) {
      const scanned = scanBalanced(s, cur, d.open, d.close);
      if (scanned) {
        shape = d.shape;
        label = unquote(scanned.content);
        explicit = true;
        cur = scanned.nextPos;
      }
      break;
    }
  }

  // Optional :::className suffix
  const clsMatch = s.slice(cur).match(/^:::[A-Za-z0-9_-]+/);
  if (clsMatch) cur += clsMatch[0].length;

  return { id, label, shape, explicit, nextPos: cur };
}

interface ParsedEdgeOp {
  label: string;
  style: "solid" | "dotted" | "thick";
  arrow: boolean;
  nextPos: number;
}

function scanUntilClosingOp(
  s: string,
  startPos: number,
  closers: string[],
): { label: string; closer: string; nextPos: number } | null {
  let i = startPos;
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    for (const c of closers) {
      if (s.startsWith(c, i)) {
        return {
          label: unquote(s.slice(startPos, i)),
          closer: c,
          nextPos: i + c.length,
        };
      }
    }
    i++;
  }
  return null;
}

function parseEdgeOp(s: string, pos: number): ParsedEdgeOp | null {
  while (pos < s.length && /\s/.test(s[pos])) pos++;
  if (pos >= s.length) return null;

  let style: "solid" | "dotted" | "thick" | null = null;
  let arrow = true;
  let label = "";
  let cur = pos;

  const directOps: Array<{ op: string; style: "solid" | "dotted" | "thick"; arrow: boolean }> = [
    { op: "-.->", style: "dotted", arrow: true },
    { op: "-.-", style: "dotted", arrow: false },
    { op: "<-->", style: "solid", arrow: true },
    { op: "==>", style: "thick", arrow: true },
    { op: "===", style: "thick", arrow: false },
    { op: "-->", style: "solid", arrow: true },
    { op: "---", style: "solid", arrow: false },
    { op: "--x", style: "solid", arrow: true },
    { op: "--o", style: "solid", arrow: true },
  ];

  for (const d of directOps) {
    if (s.startsWith(d.op, cur)) {
      style = d.style;
      arrow = d.arrow;
      cur += d.op.length;
      break;
    }
  }

  if (!style) {
    // Check inline-labeled edges: `-- text -->`, `-- text ---`, `-. text .->`, `== text ==>`
    if (s.startsWith("-.", cur)) {
      const found = scanUntilClosingOp(s, cur + 2, [".->", ".-"]);
      if (!found) return null;
      style = "dotted";
      arrow = found.closer === ".->";
      label = found.label;
      cur = found.nextPos;
    } else if (s.startsWith("==", cur)) {
      const found = scanUntilClosingOp(s, cur + 2, ["==>", "==="]);
      if (!found) return null;
      style = "thick";
      arrow = found.closer === "==>";
      label = found.label;
      cur = found.nextPos;
    } else if (s.startsWith("--", cur)) {
      const found = scanUntilClosingOp(s, cur + 2, ["-->", "---"]);
      if (!found) return null;
      style = "solid";
      arrow = found.closer === "-->";
      label = found.label;
      cur = found.nextPos;
    } else {
      return null;
    }
  }

  // Check optional pipe label `|label|` right after operator
  while (cur < s.length && s[cur] === " ") cur++;
  if (s[cur] === "|") {
    const closePipe = s.indexOf("|", cur + 1);
    if (closePipe !== -1) {
      label = unquote(s.slice(cur + 1, closePipe));
      cur = closePipe + 1;
    }
  }

  return { label, style, arrow, nextPos: cur };
}

// ─── Flowchart Parser ─────────────────────────────────────────────────────────

function parseFlowchart(rawLines: string[]): ParseMermaidResult {
  const stmts = splitStatements(rawLines);
  if (stmts.length === 0) return { ok: false, error: "Empty flowchart", kind: "flowchart" };

  const headerMatch = stmts[0].match(/^(?:flowchart|graph)(?:\s+(TD|TB|BT|RL|LR))?\s*$/i);
  if (!headerMatch) {
    return { ok: false, error: "Invalid flowchart header", kind: "flowchart" };
  }
  const direction = (headerMatch[1]?.toUpperCase() ?? "TD") as FlowDirection;

  const nodeMap = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const subgraphs: MermaidSubgraph[] = [];
  const subgraphStack: MermaidSubgraph[] = [];

  const upsertNode = (tok: ParsedNodeToken) => {
    const activeSg = subgraphStack[subgraphStack.length - 1];
    const existing = nodeMap.get(tok.id);
    if (!existing) {
      const node: MermaidNode = {
        id: tok.id,
        label: tok.label,
        shape: tok.shape,
        subgraphId: activeSg?.id,
      };
      nodeMap.set(tok.id, node);
      if (activeSg && !activeSg.nodeIds.includes(tok.id)) {
        activeSg.nodeIds.push(tok.id);
      }
    } else {
      if (tok.explicit) {
        existing.label = tok.label;
        existing.shape = tok.shape;
      }
      if (activeSg && !existing.subgraphId) {
        existing.subgraphId = activeSg.id;
        if (!activeSg.nodeIds.includes(tok.id)) activeSg.nodeIds.push(tok.id);
      }
    }
  };

  for (let idx = 1; idx < stmts.length; idx++) {
    const stmt = stmts[idx].trim();
    if (!stmt) continue;

    // Ignore styling / directives
    if (/^(?:classDef|class|style|linkStyle|click|direction)\b/i.test(stmt)) {
      continue;
    }

    if (/^end$/i.test(stmt)) {
      subgraphStack.pop();
      continue;
    }

    const sgMatch = stmt.match(/^subgraph\s+(.+)$/i);
    if (sgMatch) {
      const rest = sgMatch[1].trim();
      const bracketMatch = rest.match(/^([A-Za-z0-9_.-]+)\s*\[(.+)\]$/);
      let sgId: string;
      let sgLabel: string;
      if (bracketMatch) {
        sgId = bracketMatch[1];
        sgLabel = unquote(bracketMatch[2]);
      } else {
        sgLabel = unquote(rest);
        sgId = `sg_${subgraphs.length + 1}`;
      }
      const sg: MermaidSubgraph = { id: sgId, label: sgLabel, nodeIds: [] };
      subgraphs.push(sg);
      subgraphStack.push(sg);
      continue;
    }

    // Parse node chain: Node (EdgeOp Node)*
    const firstNode = parseNodeToken(stmt, 0);
    if (!firstNode) continue;

    let pos = firstNode.nextPos;
    while (pos < stmt.length && /\s/.test(stmt[pos])) pos++;

    if (pos >= stmt.length) {
      // Single node statement
      upsertNode(firstNode);
      continue;
    }

    let prevNode = firstNode;
    let matchedAnyEdge = false;
    while (pos < stmt.length) {
      const edgeOp = parseEdgeOp(stmt, pos);
      if (!edgeOp) break;
      const nextNode = parseNodeToken(stmt, edgeOp.nextPos);
      if (!nextNode) break;
      if (!matchedAnyEdge) {
        upsertNode(prevNode);
        matchedAnyEdge = true;
      }
      upsertNode(nextNode);
      edges.push({
        from: prevNode.id,
        to: nextNode.id,
        label: edgeOp.label,
        style: edgeOp.style,
        arrow: edgeOp.arrow,
      });
      prevNode = nextNode;
      pos = nextNode.nextPos;
      while (pos < stmt.length && /\s/.test(stmt[pos])) pos++;
    }
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length === 0) {
    return { ok: false, error: "Flowchart contains no valid nodes", kind: "flowchart" };
  }

  return {
    ok: true,
    kind: "flowchart",
    direction,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    subgraphs,
    participants: [],
    messages: [],
  };
}

// ─── State Diagram Parser ─────────────────────────────────────────────────────

function parseStateDiagram(rawLines: string[]): ParseMermaidResult {
  const stmts = splitStatements(rawLines);
  if (stmts.length === 0) return { ok: false, error: "Empty state diagram", kind: "state" };

  if (!/^stateDiagram(?:-v2)?\s*$/i.test(stmts[0])) {
    return { ok: false, error: "Invalid stateDiagram header", kind: "state" };
  }

  let direction: FlowDirection = "TD";
  const nodeMap = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  const ensureStateNode = (rawId: string, isSource: boolean): string => {
    const token = rawId.trim();
    if (token === "[*]") {
      const id = isSource ? "__start__" : "__end__";
      const shape: NodeShape = isSource ? "state-start" : "state-end";
      if (!nodeMap.has(id)) {
        nodeMap.set(id, { id, label: "[*]", shape });
      }
      return id;
    }
    const cleanId = unquote(token);
    if (!nodeMap.has(cleanId)) {
      nodeMap.set(cleanId, { id: cleanId, label: cleanId, shape: "round" });
    }
    return cleanId;
  };

  for (let idx = 1; idx < stmts.length; idx++) {
    const stmt = stmts[idx].trim();
    if (!stmt || stmt === "}" || /^note\b/i.test(stmt)) continue;

    const dirMatch = stmt.match(/^direction\s+(TD|TB|BT|RL|LR)\s*$/i);
    if (dirMatch) {
      direction = dirMatch[1].toUpperCase() as FlowDirection;
      continue;
    }

    // state "Description" as StateId
    const aliasMatch1 = stmt.match(/^state\s+("[^"]+"|'[^']+'|\S+)\s+as\s+([A-Za-z0-9_.-]+)\s*(?:\{)?$/i);
    if (aliasMatch1) {
      const id = aliasMatch1[2];
      const label = unquote(aliasMatch1[1]);
      nodeMap.set(id, { id, label, shape: "round" });
      continue;
    }

    // Transition: StateA --> StateB [: label]
    const transMatch = stmt.match(
      /^(\[\*\]|"[^"]+"|'[^']+'|[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*?)\s*(-->)\s*(\[\*\]|"[^"]+"|'[^']+'|[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)(?:\s*:\s*(.*))?$/,
    );
    if (transMatch) {
      const fromId = ensureStateNode(transMatch[1], true);
      const toId = ensureStateNode(transMatch[3], false);
      const label = (transMatch[4] ?? "").trim();
      edges.push({
        from: fromId,
        to: toId,
        label,
        style: "solid",
        arrow: true,
      });
      continue;
    }

    // State : description
    const descMatch = stmt.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
    if (descMatch) {
      const id = descMatch[1];
      const desc = descMatch[2].trim();
      const existing = nodeMap.get(id);
      if (!existing) {
        nodeMap.set(id, { id, label: `${id}: ${desc}`, shape: "round" });
      } else if (existing.label === id) {
        existing.label = `${id}: ${desc}`;
      }
      continue;
    }
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length === 0) {
    return { ok: false, error: "State diagram contains no valid states", kind: "state" };
  }

  return {
    ok: true,
    kind: "state",
    direction,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    subgraphs: [],
    participants: [],
    messages: [],
  };
}

// ─── Sequence Diagram Parser ──────────────────────────────────────────────────

function parseSequenceDiagram(rawLines: string[]): ParseMermaidResult {
  const stmts = splitStatements(rawLines);
  if (stmts.length === 0) return { ok: false, error: "Empty sequence diagram", kind: "sequence" };

  if (!/^sequenceDiagram\s*$/i.test(stmts[0])) {
    return { ok: false, error: "Invalid sequenceDiagram header", kind: "sequence" };
  }

  const participantMap = new Map<string, SequenceParticipant>();
  const messages: SequenceMessage[] = [];

  const ensureParticipant = (id: string, label?: string, actor = false) => {
    const cleanId = unquote(id.trim());
    const cleanLabel = label !== undefined ? unquote(label.trim()) : cleanId;
    const existing = participantMap.get(cleanId);
    if (!existing) {
      participantMap.set(cleanId, { id: cleanId, label: cleanLabel, actor });
    } else if (label !== undefined) {
      existing.label = cleanLabel;
      if (actor) existing.actor = true;
    }
    return cleanId;
  };

  for (let idx = 1; idx < stmts.length; idx++) {
    const stmt = stmts[idx].trim();
    if (!stmt) continue;

    if (/^(?:autonumber|activate|deactivate|loop|alt|else|opt|par|and|rect|end|note)\b/i.test(stmt)) {
      continue;
    }

    const partMatch = stmt.match(/^(participant|actor)\s+("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)(?:\s+as\s+(.+))?$/i);
    if (partMatch) {
      const isActor = partMatch[1].toLowerCase() === "actor";
      const rawId = partMatch[2];
      const rawAlias = partMatch[3];
      ensureParticipant(rawId, rawAlias ?? rawId, isActor);
      continue;
    }

    // Message arrow: Alice ->> Bob : Hello
    const msgMatch = stmt.match(
      /^("[^"]+"|'[^']+'|[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*?)\s*(-->>|->>|--x|-x|-->|->)[+-]?\s*("[^"]+"|'[^']+'|[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)\s*(?::\s*(.*))?$/,
    );
    if (msgMatch) {
      const from = ensureParticipant(msgMatch[1]);
      const op = msgMatch[2];
      const to = ensureParticipant(msgMatch[3]);
      const text = (msgMatch[4] ?? "").trim();
      const dashed = op.startsWith("--");
      const arrow: "filled" | "open" | "cross" = op.endsWith("x")
        ? "cross"
        : op.endsWith(">>")
          ? "filled"
          : "open";
      messages.push({ from, to, text, dashed, arrow });
      continue;
    }
  }

  const participants = Array.from(participantMap.values());
  if (participants.length === 0) {
    return {
      ok: false,
      error: "Sequence diagram contains no participants or messages",
      kind: "sequence",
    };
  }

  const nodes: MermaidNode[] = participants.map((p) => ({
    id: p.id,
    label: p.label,
    shape: p.actor ? "stadium" : "rect",
  }));

  const edges: MermaidEdge[] = messages.map((m) => ({
    from: m.from,
    to: m.to,
    label: m.text,
    style: m.dashed ? "dotted" : "solid",
    arrow: true,
    cross: m.arrow === "cross",
    openArrow: m.arrow === "open",
  }));

  return {
    ok: true,
    kind: "sequence",
    direction: "TB",
    nodeCount: participants.length,
    edgeCount: messages.length,
    nodes,
    edges,
    subgraphs: [],
    participants,
    messages,
  };
}

// ─── Public Parser Entrypoint ─────────────────────────────────────────────────

export function parseMermaid(code: string): ParseMermaidResult {
  try {
    const kind = detectMermaidKind(code);
    if (kind === "unknown") {
      return {
        ok: false,
        error: typeof code === "string" && code.trim()
          ? "Unsupported or unrecognized Mermaid diagram kind"
          : "Empty Mermaid diagram",
        kind: "unknown",
      };
    }
    const lines = stripFrontmatterAndComments(code);
    if (kind === "flowchart") return parseFlowchart(lines);
    if (kind === "state") return parseStateDiagram(lines);
    if (kind === "sequence") return parseSequenceDiagram(lines);
    return { ok: false, error: "Unsupported Mermaid diagram kind", kind: "unknown" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to parse Mermaid diagram",
    };
  }
}

// ─── Layered Graph Layout & SVG Renderer (Flowchart + State) ──────────────────

interface PositionedNode extends MermaidNode {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

function measureNode(node: MermaidNode): { w: number; h: number } {
  if (node.shape === "state-start" || node.shape === "state-end") {
    return { w: 28, h: 28 };
  }
  const textWidth = Math.max(48, node.label.length * 7.8);
  if (node.shape === "circle") {
    const d = Math.max(54, Math.min(140, textWidth + 26));
    return { w: d, h: d };
  }
  if (node.shape === "diamond") {
    return { w: Math.max(96, textWidth + 48), h: 54 };
  }
  return { w: Math.max(84, textWidth + 30), h: 38 };
}

function assignLayers(nodes: MermaidNode[], edges: MermaidEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  // Cycle-safe topological layer assignment
  const layer = new Map<string, number>();
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const n of nodes) {
    if ((indeg.get(n.id) ?? 0) === 0) {
      layer.set(n.id, 0);
      queue.push(n.id);
    }
  }
  if (queue.length === 0 && nodes.length > 0) {
    layer.set(nodes[0].id, 0);
    queue.push(nodes[0].id);
  }

  while (visited.size < nodes.length) {
    if (queue.length === 0) {
      const nextUnvisited = nodes.find((n) => !visited.has(n.id));
      if (!nextUnvisited) break;
      if (!layer.has(nextUnvisited.id)) layer.set(nextUnvisited.id, 0);
      queue.push(nextUnvisited.id);
    }
    const u = queue.shift()!;
    if (visited.has(u)) continue;
    visited.add(u);
    const uLayer = layer.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) {
        layer.set(v, Math.max(layer.get(v) ?? 0, uLayer + 1));
        indeg.set(v, (indeg.get(v) ?? 1) - 1);
        if ((indeg.get(v) ?? 0) <= 0) {
          queue.push(v);
        }
      }
    }
  }

  return layer;
}

function renderLayeredGraphSvg(parsed: Extract<ParseMermaidResult, { ok: true }>): string {
  const { nodes, edges, subgraphs, direction } = parsed;
  const layerMap = assignLayers(nodes, edges);
  const maxLayer = Math.max(0, ...Array.from(layerMap.values()));

  const layers: MermaidNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) {
    const l = layerMap.get(n.id) ?? 0;
    layers[l].push(n);
  }

  const isHorizontal = direction === "LR" || direction === "RL";
  const isReversed = direction === "BT" || direction === "RL";

  const layerGap = isHorizontal ? 96 : 74;
  const siblingGap = isHorizontal ? 34 : 42;
  const padX = 40;
  const padY = 40;

  // Compute primary-axis sizes per layer and secondary-axis span per layer
  const layerPrimarySize = layers.map((group) =>
    group.reduce((acc, n) => {
      const m = measureNode(n);
      return Math.max(acc, isHorizontal ? m.w : m.h);
    }, 40),
  );

  const layerSecondarySpan = layers.map((group) => {
    let sum = 0;
    group.forEach((n, idx) => {
      const m = measureNode(n);
      sum += isHorizontal ? m.h : m.w;
      if (idx > 0) sum += siblingGap;
    });
    return sum;
  });

  const maxSecondarySpan = Math.max(160, ...layerSecondarySpan);
  const totalPrimarySpan =
    layerPrimarySize.reduce((a, b) => a + b, 0) + Math.max(0, layers.length - 1) * layerGap;

  const positioned = new Map<string, PositionedNode>();
  let primaryCursor = isHorizontal ? padX : padY;

  const orderedLayerIndices = layers.map((_, idx) => idx);
  if (isReversed) orderedLayerIndices.reverse();

  for (const lIdx of orderedLayerIndices) {
    const group = layers[lIdx];
    const pSize = layerPrimarySize[lIdx];
    const secSpan = layerSecondarySpan[lIdx];
    let secCursor = (isHorizontal ? padY : padX) + (maxSecondarySpan - secSpan) / 2;

    for (const n of group) {
      const { w, h } = measureNode(n);
      const cx = isHorizontal ? primaryCursor + pSize / 2 : secCursor + w / 2;
      const cy = isHorizontal ? secCursor + h / 2 : primaryCursor + pSize / 2;
      positioned.set(n.id, {
        ...n,
        x: cx,
        y: cy,
        w,
        h,
        layer: lIdx,
      });
      secCursor += (isHorizontal ? h : w) + siblingGap;
    }

    primaryCursor += pSize + layerGap;
  }

  const svgWidth = Math.ceil((isHorizontal ? totalPrimarySpan : maxSecondarySpan) + padX * 2);
  const svgHeight = Math.ceil((isHorizontal ? maxSecondarySpan : totalPrimarySpan) + padY * 2);

  const parts: string[] = [];

  // Render subgraphs
  for (const sg of subgraphs) {
    const members = sg.nodeIds
      .map((id) => positioned.get(id))
      .filter((n): n is PositionedNode => Boolean(n));
    if (members.length === 0) continue;
    const minX = Math.min(...members.map((m) => m.x - m.w / 2)) - 18;
    const maxX = Math.max(...members.map((m) => m.x + m.w / 2)) + 18;
    const minY = Math.min(...members.map((m) => m.y - m.h / 2)) - 28;
    const maxY = Math.max(...members.map((m) => m.y + m.h / 2)) + 16;
    parts.push(
      `<g class="mermaid-subgraph" data-subgraph-id="${escapeXml(sg.id)}">` +
        `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="6" ry="6" fill="rgba(24,27,52,0.55)" stroke="#38f6ff" stroke-opacity="0.45" stroke-dasharray="5,4" stroke-width="1.2" />` +
        `<text x="${minX + 10}" y="${minY + 16}" fill="#b4aee0" font-size="11" font-family="JetBrains Mono, Consolas, monospace" font-weight="600">${escapeXml(sg.label)}</text>` +
      `</g>`,
    );
  }

  // Render edges
  for (const e of edges) {
    const src = positioned.get(e.from);
    const dst = positioned.get(e.to);
    if (!src || !dst) continue;

    let x1 = src.x;
    let y1 = src.y;
    let x2 = dst.x;
    let y2 = dst.y;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;

    if (src.id === dst.id) {
      // Self-loop
      const rx = src.x + src.w / 2;
      const ry = src.y;
      const pathD = `M ${rx} ${ry - 8} C ${rx + 36} ${ry - 28}, ${rx + 36} ${ry + 28}, ${rx} ${ry + 8}`;
      parts.push(
        `<path d="${pathD}" fill="none" stroke="#b4aee0" stroke-width="1.6" ${
          e.arrow ? 'marker-end="url(#mermaid-arrow)"' : ""
        } />`,
      );
      if (e.label) {
        parts.push(
          `<text x="${rx + 40}" y="${ry + 4}" fill="#38f6ff" font-size="11" font-family="JetBrains Mono, Consolas, monospace">${escapeXml(e.label)}</text>`,
        );
      }
      continue;
    }

    if (isHorizontal) {
      const signX = dx >= 0 ? 1 : -1;
      x1 = src.x + (src.w / 2) * signX;
      x2 = dst.x - (dst.w / 2 + (e.arrow ? 4 : 0)) * signX;
      if (Math.abs(dx) < (src.w + dst.w) / 2) {
        x1 = src.x + (dx / dist) * (src.w / 2);
        y1 = src.y + (dy / dist) * (src.h / 2);
        x2 = dst.x - (dx / dist) * (dst.w / 2 + 4);
        y2 = dst.y - (dy / dist) * (dst.h / 2 + 4);
      }
    } else {
      const signY = dy >= 0 ? 1 : -1;
      y1 = src.y + (src.h / 2) * signY;
      y2 = dst.y - (dst.h / 2 + (e.arrow ? 4 : 0)) * signY;
      if (Math.abs(dy) < (src.h + dst.h) / 2) {
        x1 = src.x + (dx / dist) * (src.w / 2);
        y1 = src.y + (dy / dist) * (src.h / 2);
        x2 = dst.x - (dx / dist) * (dst.w / 2 + 4);
        y2 = dst.y - (dy / dist) * (dst.h / 2 + 4);
      }
    }

    const cx1 = isHorizontal ? (x1 + x2) / 2 : x1;
    const cy1 = isHorizontal ? y1 : (y1 + y2) / 2;
    const cx2 = isHorizontal ? (x1 + x2) / 2 : x2;
    const cy2 = isHorizontal ? y2 : (y1 + y2) / 2;

    const strokeDash = e.style === "dotted" ? ' stroke-dasharray="5,4"' : "";
    const strokeWidth = e.style === "thick" ? "2.6" : "1.6";
    const strokeColor = e.style === "thick" ? "#38f6ff" : "#b4aee0";
    const markerAttr = e.arrow ? ' marker-end="url(#mermaid-arrow)"' : "";

    parts.push(
      `<path class="mermaid-edge" d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"${strokeDash}${markerAttr} />`,
    );

    if (e.label) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const lw = Math.max(28, e.label.length * 7 + 14);
      const lh = 18;
      parts.push(
        `<g class="mermaid-edge-label">` +
          `<rect x="${(mx - lw / 2).toFixed(1)}" y="${(my - lh / 2).toFixed(1)}" width="${lw}" height="${lh}" rx="3" ry="3" fill="#0c0d1b" stroke="#2e325c" stroke-width="1" />` +
          `<text x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" fill="#38f6ff" font-size="11" font-family="JetBrains Mono, Consolas, monospace">${escapeXml(e.label)}</text>` +
        `</g>`,
      );
    }
  }

  // Render nodes
  for (const n of positioned.values()) {
    const left = n.x - n.w / 2;
    const top = n.y - n.h / 2;

    if (n.shape === "state-start") {
      parts.push(
        `<g class="mermaid-node" data-node-id="${escapeXml(n.id)}" data-shape="state-start">` +
          `<circle cx="${n.x}" cy="${n.y}" r="9" fill="#38f6ff" stroke="#f1f5ff" stroke-width="1.5" />` +
          `<title>${escapeXml(n.label)}</title>` +
        `</g>`,
      );
      continue;
    }

    if (n.shape === "state-end") {
      parts.push(
        `<g class="mermaid-node" data-node-id="${escapeXml(n.id)}" data-shape="state-end">` +
          `<circle cx="${n.x}" cy="${n.y}" r="11" fill="#111326" stroke="#38f6ff" stroke-width="1.8" />` +
          `<circle cx="${n.x}" cy="${n.y}" r="5.5" fill="#38f6ff" />` +
          `<title>${escapeXml(n.label)}</title>` +
        `</g>`,
      );
      continue;
    }

    let shapeSvg = "";
    if (n.shape === "diamond") {
      const pts = [
        `${n.x},${top}`,
        `${left + n.w},${n.y}`,
        `${n.x},${top + n.h}`,
        `${left},${n.y}`,
      ].join(" ");
      shapeSvg = `<polygon points="${pts}" fill="#181b34" stroke="#c28cff" stroke-width="1.5" />`;
    } else if (n.shape === "circle") {
      shapeSvg = `<circle cx="${n.x}" cy="${n.y}" r="${n.w / 2}" fill="#181b34" stroke="#38f6ff" stroke-width="1.5" />`;
    } else if (n.shape === "stadium") {
      shapeSvg = `<rect x="${left}" y="${top}" width="${n.w}" height="${n.h}" rx="${n.h / 2}" ry="${n.h / 2}" fill="#181b34" stroke="#4df7a6" stroke-width="1.5" />`;
    } else if (n.shape === "round") {
      shapeSvg = `<rect x="${left}" y="${top}" width="${n.w}" height="${n.h}" rx="10" ry="10" fill="#181b34" stroke="#38f6ff" stroke-width="1.5" />`;
    } else {
      shapeSvg = `<rect x="${left}" y="${top}" width="${n.w}" height="${n.h}" rx="3" ry="3" fill="#181b34" stroke="#38f6ff" stroke-width="1.5" />`;
    }

    parts.push(
      `<g class="mermaid-node" data-node-id="${escapeXml(n.id)}" data-shape="${n.shape}">` +
        shapeSvg +
        `<text x="${n.x}" y="${n.y + 4}" text-anchor="middle" fill="#f1f5ff" font-size="12" font-family="JetBrains Mono, Consolas, monospace">${escapeXml(n.label)}</text>` +
      `</g>`,
    );
  }

  return buildSvgEnvelope(svgWidth, svgHeight, parts.join("\n"));
}

// ─── Sequence Diagram SVG Renderer ────────────────────────────────────────────

function renderSequenceSvg(parsed: Extract<ParseMermaidResult, { ok: true }>): string {
  const { participants, messages } = parsed;
  const boxHeight = 36;
  const topY = 24;
  const rowGap = 46;
  const minColGap = 150;

  const boxWidths = participants.map((p) => Math.max(92, p.label.length * 8 + 28));
  let maxMsgSpan = minColGap;
  for (const m of messages) {
    maxMsgSpan = Math.max(maxMsgSpan, m.text.length * 7.2 + 54);
  }
  const colGap = Math.max(minColGap, Math.min(240, maxMsgSpan));

  const padX = 48;
  const centers = participants.map((_, idx) => padX + boxWidths[0] / 2 + idx * colGap);
  const pIndex = new Map<string, number>();
  participants.forEach((p, idx) => pIndex.set(p.id, idx));

  const lifelineStart = topY + boxHeight;
  const lifelineEnd = lifelineStart + Math.max(1, messages.length) * rowGap + 28;
  const svgWidth = Math.ceil(
    (centers[centers.length - 1] ?? 120) + (boxWidths[boxWidths.length - 1] ?? 92) / 2 + padX,
  );
  const svgHeight = Math.ceil(lifelineEnd + 28);

  const parts: string[] = [];

  // Lifelines & participant headers
  participants.forEach((p, idx) => {
    const cx = centers[idx];
    const bw = boxWidths[idx];
    parts.push(
      `<line class="mermaid-lifeline" x1="${cx}" y1="${lifelineStart}" x2="${cx}" y2="${lifelineEnd}" stroke="#2e325c" stroke-width="1.5" stroke-dasharray="5,4" />`,
    );
    const stroke = p.actor ? "#c28cff" : "#38f6ff";
    const rx = p.actor ? 18 : 4;
    parts.push(
      `<g class="mermaid-participant" data-participant-id="${escapeXml(p.id)}">` +
        `<rect x="${cx - bw / 2}" y="${topY}" width="${bw}" height="${boxHeight}" rx="${rx}" ry="${rx}" fill="#181b34" stroke="${stroke}" stroke-width="1.5" />` +
        `<text x="${cx}" y="${topY + 22}" text-anchor="middle" fill="#f1f5ff" font-size="12" font-family="JetBrains Mono, Consolas, monospace" font-weight="600">${escapeXml(p.label)}</text>` +
      `</g>`,
    );
  });

  // Messages
  messages.forEach((m, idx) => {
    const fromIdx = pIndex.get(m.from) ?? 0;
    const toIdx = pIndex.get(m.to) ?? 0;
    const x1 = centers[fromIdx];
    const x2 = centers[toIdx];
    const y = lifelineStart + 32 + idx * rowGap;
    const dashAttr = m.dashed ? ' stroke-dasharray="5,4"' : "";
    const markerId =
      m.arrow === "cross"
        ? "mermaid-arrow-cross"
        : m.arrow === "open"
          ? "mermaid-arrow-open"
          : "mermaid-arrow";

    if (fromIdx === toIdx) {
      const pathD = `M ${x1} ${y - 6} L ${x1 + 34} ${y - 6} L ${x1 + 34} ${y + 12} L ${x1 + 4} ${y + 12}`;
      parts.push(
        `<g class="mermaid-message">` +
          `<path d="${pathD}" fill="none" stroke="#b4aee0" stroke-width="1.5"${dashAttr} marker-end="url(#${markerId})" />` +
          (m.text
            ? `<text x="${x1 + 40}" y="${y + 4}" fill="#38f6ff" font-size="11" font-family="JetBrains Mono, Consolas, monospace">${escapeXml(m.text)}</text>`
            : "") +
        `</g>`,
      );
    } else {
      const dir = x2 > x1 ? 1 : -1;
      const endX = x2 - dir * 5;
      const midX = (x1 + x2) / 2;
      parts.push(
        `<g class="mermaid-message">` +
          `<line x1="${x1}" y1="${y}" x2="${endX}" y2="${y}" stroke="#b4aee0" stroke-width="1.6"${dashAttr} marker-end="url(#${markerId})" />` +
          (m.text
            ? `<text x="${midX}" y="${y - 7}" text-anchor="middle" fill="#38f6ff" font-size="11" font-family="JetBrains Mono, Consolas, monospace">${escapeXml(m.text)}</text>`
            : "") +
        `</g>`,
      );
    }
  });

  return buildSvgEnvelope(svgWidth, svgHeight, parts.join("\n"));
}

function buildSvgEnvelope(width: number, height: number, body: string): string {
  const defs =
    `<defs>` +
    `<marker id="mermaid-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M 0 1 L 10 5 L 0 9 z" fill="#38f6ff" />` +
    `</marker>` +
    `<marker id="mermaid-arrow-open" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#38f6ff" stroke-width="1.8" />` +
    `</marker>` +
    `<marker id="mermaid-arrow-cross" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path d="M 2 2 L 8 8 M 8 2 L 2 8" fill="none" stroke="#ff8573" stroke-width="1.8" />` +
    `</marker>` +
    `</defs>`;

  const raw =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="max-width:100%;height:auto;image-rendering:auto;display:block;" shape-rendering="geometricPrecision">` +
    `<rect width="${width}" height="${height}" fill="#0c0d1b" rx="4" ry="4" />` +
    defs +
    body +
    `</svg>`;

  return sanitizeSvg(raw);
}

// ─── Public SVG Render Entrypoint ─────────────────────────────────────────────

export function renderMermaidSvg(code: string): RenderMermaidResult {
  const parsed = parseMermaid(code);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const svg =
    parsed.kind === "sequence"
      ? renderSequenceSvg(parsed)
      : renderLayeredGraphSvg(parsed);

  return {
    ok: true,
    svg,
    kind: parsed.kind,
    nodeCount: parsed.nodeCount,
    edgeCount: parsed.edgeCount,
  };
}

// ─── Safe SVG-to-React Element Converter ──────────────────────────────────────

const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "defs",
  "marker",
  "rect",
  "circle",
  "polygon",
  "path",
  "line",
  "g",
  "text",
  "title",
]);

function domNodeToReact(node: Node, key: string): ReactNode {
  if (node.nodeType === 3) {
    return node.textContent;
  }
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_SVG_TAGS.has(tag)) return null;

  const props: Record<string, any> = { key };
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    const name = attr.name;
    if (/^on/i.test(name)) continue;
    if (name === "style") continue;
    if (name === "class") {
      props.className = attr.value;
    } else {
      props[name] = attr.value;
    }
  }
  if (tag === "svg") {
    props.style = {
      maxWidth: "100%",
      height: "auto",
      imageRendering: "auto",
      display: "block",
    };
  }

  const children: ReactNode[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = domNodeToReact(el.childNodes[i], `${key}-${i}`);
    if (child !== null) children.push(child);
  }
  return createElement(tag, props, ...children);
}

function renderSafeSvgElement(svgMarkup: string): ReactNode {
  const clean = sanitizeSvg(svgMarkup);
  if (typeof DOMParser === "undefined") return null;
  try {
    const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
    const svgEl = doc.querySelector("svg");
    if (!svgEl) return null;
    return domNodeToReact(svgEl, "svg-root");
  } catch {
    return null;
  }
}

// ─── React Component ──────────────────────────────────────────────────────────

export function MermaidView({ code }: { code: string }) {
  const detectedKind = useMemo(() => detectMermaidKind(code), [code]);
  const rendered = useMemo(() => renderMermaidSvg(code), [code]);
  const [mode, setMode] = useState<"diagram" | "source">(() =>
    rendered.ok ? "diagram" : "source",
  );
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMode(rendered.ok ? "diagram" : "source");
    setZoom(1);
  }, [code, rendered.ok]);

  const svgElement = useMemo(
    () => (rendered.ok ? renderSafeSvgElement(rendered.svg) : null),
    [rendered],
  );

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const activeMode = rendered.ok ? mode : "source";

  return (
    <div
      className="tl-code-block mermaid-view"
      data-testid="mermaid-view"
      style={{
        border: "1px solid var(--line, #2e325c)",
        background: "var(--navy, #0c0d1b)",
        margin: "8px 0",
      }}
    >
      <div
        className="mermaid-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "4px 8px",
          borderBottom: "1px solid var(--line, #2e325c)",
          background: "var(--panel, #111326)",
          fontSize: 11,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            className="badge"
            data-testid="mermaid-badge"
            style={{
              color: "var(--cyan, #38f6ff)",
              fontWeight: 700,
              letterSpacing: "0.5px",
            }}
          >
            MERMAID
          </span>
          <span className="muted" data-testid="mermaid-kind">
            {detectedKind}
          </span>
          {!rendered.ok && (
            <span className="muted" data-testid="mermaid-fallback-note" style={{ fontSize: 10 }}>
              (source fallback: {rendered.error})
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {activeMode === "diagram" && rendered.ok && (
            <>
              <button
                type="button"
                className="btn ghost"
                data-testid="mermaid-zoom-out"
                style={{ padding: "1px 5px", fontSize: 10 }}
                onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                title="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                className="btn ghost"
                data-testid="mermaid-zoom-reset"
                style={{ padding: "1px 5px", fontSize: 10 }}
                onClick={() => setZoom(1)}
                title="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="btn ghost"
                data-testid="mermaid-zoom-in"
                style={{ padding: "1px 5px", fontSize: 10 }}
                onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.25).toFixed(2)))}
                title="Zoom in"
              >
                +
              </button>
            </>
          )}
          <button
            type="button"
            className="btn ghost"
            data-testid="mermaid-toggle-btn"
            disabled={!rendered.ok}
            style={{ padding: "1px 6px", fontSize: 11 }}
            onClick={() => setMode((m) => (m === "diagram" ? "source" : "diagram"))}
          >
            {activeMode === "diagram" ? "Source" : "Diagram"}
          </button>
          <button
            type="button"
            className="btn ghost"
            data-testid="mermaid-copy-btn"
            style={{ padding: "1px 6px", fontSize: 11 }}
            onClick={handleCopy}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {activeMode === "diagram" && rendered.ok ? (
        <div
          className="mermaid-diagram-container"
          data-testid="mermaid-diagram"
          style={{
            overflow: "auto",
            padding: 12,
            maxHeight: 520,
          }}
        >
          <div
            style={{
              transform: zoom !== 1 ? `scale(${zoom})` : undefined,
              transformOrigin: "top left",
              display: "inline-block",
              minWidth: "100%",
            }}
          >
            {svgElement}
          </div>
        </div>
      ) : (
        <div className="mermaid-source-container" data-testid="mermaid-source" style={{ padding: 8 }}>
          <pre className="tl-code"><code>{code}</code></pre>
        </div>
      )}
    </div>
  );
}
