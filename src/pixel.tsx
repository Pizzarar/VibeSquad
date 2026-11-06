// Cast portraits come from the hand-drawn sheet (see cast.ts); this file holds the Avatar,
// provider badges (original glyphs + neon palette), synthwave team emblems and raw-token meters.

import type { CSSProperties } from "react";
import type { AgentType } from "./teams";
import { CAST_CELL, CAST_SHOWN, CAST_URL, CAST_VARIANTS, castCell } from "./cast";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type RGB = [number, number, number];
const rgb = (c: string): RGB => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as RGB;
const toHex = (v: RGB) => "#" + v.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");
const shade = (c: string, f: number) => toHex(rgb(c).map((v) => v * f) as RGB);

// ---- providers: colour + original glyph (never a real logo) -----------------------

export type ProviderSpec = {
  key: string;
  name: string;
  color: string;
  dim: string;
  symbol: string;
};

const PROVIDERS: [RegExp, ProviderSpec][] = [
  [/claude|anthropic/i, { key: "claude", name: "Claude Code", color: "#ff6e59", dim: "#7a2620", symbol: "✶" }],
  [/codex|openai/i, { key: "codex", name: "Codex", color: "#e2e8f0", dim: "#475569", symbol: "●" }],
  [/antigravity|gemini|agy/i, { key: "gemini", name: "Gemini", color: "#00f0ff", dim: "#005f73", symbol: "◆" }],
  [/opencode/i, { key: "opencode", name: "OpenCode", color: "#b86bff", dim: "#4c1d95", symbol: "▲" }],
  [/cursor/i, { key: "cursor", name: "Cursor", color: "#39ff88", dim: "#14532d", symbol: "▸" }],
  [/copilot/i, { key: "copilot", name: "Copilot", color: "#ffd166", dim: "#78350f", symbol: "❖" }],
  [/codewhale|deepseek-harness/i, { key: "codewhale", name: "CodeWhale", color: "#38bdf8", dim: "#1e3a8a", symbol: "≈" }],
  [/^(pi|omp)$/i, { key: "pi", name: "Pi", color: "#ff2a85", dim: "#831843", symbol: "π" }],
];

// Providers without a dedicated row get a stable hue from this list (none collide with the rows above).
export const DEDICATED_PROVIDER_KEYS = PROVIDERS.map(([, s]) => s.key);
export function listDedicatedProviders(): ProviderSpec[] {
  return PROVIDERS.map(([, s]) => ({ ...s }));
}
export const GENERIC_HUES = ["#a3e635", "#2dd4bf", "#fb923c", "#e879f9", "#60a5fa", "#f43f5e", "#facc15", "#c084fc"];

export type ProviderOverride = { color?: string; symbol?: string; name?: string; dim?: string };
let overrides: Record<string, ProviderOverride> = {};

export function setProviderOverrides(next: Record<string, ProviderOverride> | null | undefined) {
  overrides = next && typeof next === "object" ? next : {};
}

export function getProviderOverrides(): Record<string, ProviderOverride> {
  return overrides;
}

/** Keyed by source/tool, not model: "opencode/deepseek/x" is OpenCode. */
export function providerSpec(provider: string, label?: string): ProviderSpec {
  const raw = String(provider ?? "").trim();
  const source = (raw.split("/")[0] || raw).trim();
  const key = source.toLowerCase();
  let spec = PROVIDERS.find(([re]) => re.test(source))?.[1];
  if (!spec) {
    const color = GENERIC_HUES[hash(key || "other") % GENERIC_HUES.length];
    const initial = (label?.trim() || source).match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() || "◈";
    spec = {
      key: key || "other",
      name: label?.trim() || (source ? source.charAt(0).toUpperCase() + source.slice(1) : "Synth"),
      color,
      dim: shade(color, 0.38),
      symbol: initial,
    };
  }
  const o = overrides[key] ?? overrides[spec.key];
  if (o) {
    const color = o.color ?? spec.color;
    spec = {
      ...spec,
      color,
      dim: o.dim ?? (o.color ? shade(o.color, 0.38) : spec.dim),
      symbol: o.symbol ?? spec.symbol,
      name: o.name ?? spec.name,
    };
  }
  return spec;
}

export function providerColor(provider: string): string {
  return providerSpec(provider).color;
}

// ---- components ------------------------------------------------------------------

/** A cast member, cut from the hand-drawn sheet (public/cast.png) and shown pixelated at whole multiples of 32. */
export function Avatar({
  id,
  provider,
  providerLabel,
  agentType = "unknown",
  size = 32,
  variant,
}: {
  id: string;
  provider: string;
  providerLabel?: string;
  agentType?: AgentType;
  size?: number;
  /** Lead look bucket (the lane ordinal); leads with none fall back to the id hash. */
  variant?: number;
}) {
  const p = providerSpec(provider, providerLabel);
  const tag = String((hash(id) % 90) + 10);
  const retired = agentType === "retired-lead";
  // Snap to 16 (half) or a whole multiple of 32 so the art never drops pixel rows or columns.
  const snapped = size < 24 ? 16 : Math.max(CAST_SHOWN, Math.round(size / CAST_SHOWN) * CAST_SHOWN);
  const scale = snapped / CAST_CELL;
  const cell = snapped;
  const { x, y } = castCell(id, agentType, variant);
  const roleLabel = agentType === "brainstorm" ? "Brainstorm" : agentType;

  return (
    <span
      className={`avatar type-${agentType} prov-${p.key} ${retired ? "is-retired" : ""}`}
      style={{ width: snapped, height: snapped }}
      title={`${roleLabel} · ${p.name} (#${tag})`}
    >
      <span
        className="cast-sprite"
        role="img"
        aria-label={roleLabel}
        style={{
          width: cell,
          height: cell,
          backgroundImage: `url(${CAST_URL})`,
          backgroundSize: `${CAST_VARIANTS * cell}px auto`,
          backgroundPosition: `${-x * scale}px ${-y * scale}px`,
        }}
      />
      <span className="prov-badge" style={{ color: p.color }}>
        {p.symbol}
      </span>
      {size >= 44 && <span className="unit-tag">#{tag}</span>}
    </span>
  );
}

// Up to two initials for a team name: split on spaces, -, _ and camelCase; "?" when empty.
export function initials(name: string, size = 20): string {
  const parts = (name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s\-_]+/)
    .filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => Array.from(p)[0].toUpperCase());
  if (!letters.length) return "?";
  return size < 16 ? letters[0] : letters.join("");
}

// Black or white text, whichever contrasts better with a #rrggbb fill.
function inkFor(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return "#fff";
  const lin = (i: number) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // contrast vs #080814 (L~0.007) compared with contrast vs white
  return (L + 0.05) / 0.057 >= 1.05 / (L + 0.05) ? "#080814" : "#fff";
}

// Monogram tile for teams and worktrees. `icon` is a seam for a later icon picker (unused).
export function TeamEmblem({ name, color, size = 20 }: { name: string; color: string; size?: number; icon?: string }) {
  return (
    <span
      className="team-emblem"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.22),
        background: color,
        color: inkFor(color),
        fontSize: Math.max(7, Math.round(size * (size < 16 ? 0.6 : 0.42))),
      }}
    >
      {initials(name, size)}
    </span>
  );
}

export function fmtTokens(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

// Context usage meter showing raw tokens against budget (e.g. "114k / 150k").
// Cool cyan/violet for normal levels; amber at warnAt (150k); hot pink (#ff2a85) at alertAt (250k) / capAt (300k).
export function TokenMeter({
  used,
  budget,
  ladder,
}: {
  used?: number | null;
  budget: number;
  ladder?: { warnAt: number; alertAt: number; capAt: number };
}) {
  const val = used ?? 0;
  if (ladder) {
    const cap = Math.max(1, ladder.capAt);
    const pct = Math.min(1, val / cap);
    const warnPct = Math.min(100, Math.max(0, (ladder.warnAt / cap) * 100));
    const alertPct = Math.min(100, Math.max(0, (ladder.alertAt / cap) * 100));
    const tone = val >= ladder.alertAt ? "alert" : val >= ladder.warnAt ? "warn" : "cool";
    const text = `${fmtTokens(val)} / ${fmtTokens(ladder.warnAt)} · ${fmtTokens(ladder.alertAt)} auto · ${fmtTokens(ladder.capAt)} cap`;
    return (
      <div
        className={`meter ${tone} meter-ladder`}
        data-testid="lead-token-meter"
        title={`Lead context: ${val.toLocaleString()} tokens (soft flag at ${ladder.warnAt.toLocaleString()}, auto-handoff at ${ladder.alertAt.toLocaleString()}, hard cap ${ladder.capAt.toLocaleString()})`}
      >
        <div className="meter-track" style={{ position: "relative" }}>
          <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
          <span
            className="brainstorm-ctx-marker"
            style={{ left: `${warnPct}%` }}
            title={`Soft flag (${fmtTokens(ladder.warnAt)})`}
          />
          <span
            className="brainstorm-ctx-marker"
            style={{ left: `${alertPct}%` }}
            title={`Auto-handoff (${fmtTokens(ladder.alertAt)})`}
          />
        </div>
        <span className="meter-readout">{text}</span>
      </div>
    );
  }
  const pct = Math.min(1, val / budget);
  const tone = pct >= 0.9 ? "alert" : pct >= 0.72 ? "warn" : "cool";
  const text = `${fmtTokens(val)} / ${fmtTokens(budget)}`;
  return (
    <div className={`meter ${tone}`} title={`${val.toLocaleString()} / ${budget.toLocaleString()} tokens`}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="meter-readout">{text}</span>
    </div>
  );
}
