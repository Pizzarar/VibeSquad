// Pure logic for the drawer "Features" menu (Paseo setAgentFeature / applyAgentConfig).
// No React, DOM or daemon imports, so node --test can load this file directly.

export type FeatureLike = {
  type: "toggle" | "select";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  value: boolean | string | null;
  options?: Array<{ id: string; label: string }>;
};

export type FeatureRow = {
  id: string;
  label: string;
  hint: string;
  kind: "toggle" | "select";
  value: boolean | string | null;
  options: Array<{ id: string; label: string }>;
};

/** Normalizes the snapshot's `features` into rows the menu renders. Unknown shapes are dropped. */
export function featureRows(features: readonly unknown[] | null | undefined): FeatureRow[] {
  const rows: FeatureRow[] = [];
  for (const raw of features ?? []) {
    const f = raw as FeatureLike;
    if (!f || typeof f.id !== "string" || !f.id) continue;
    if (f.type === "toggle") {
      rows.push({ id: f.id, label: f.label || f.id, hint: f.description || f.tooltip || "", kind: "toggle", value: !!f.value, options: [] });
    } else if (f.type === "select" && Array.isArray(f.options)) {
      rows.push({
        id: f.id,
        label: f.label || f.id,
        hint: f.description || f.tooltip || "",
        kind: "select",
        value: f.value ?? null,
        options: f.options
          .filter((o) => !!o && typeof o.id === "string" && !!o.id)
          .map((o) => ({ id: o.id, label: o.label || o.id })),
      });
    }
  }
  return rows;
}

/** A feature value the control would send, or null when it would not change anything. */
export function featureChange(row: FeatureRow, next: boolean | string): boolean | string | null {
  if (row.kind === "toggle") return typeof next === "boolean" && next !== row.value ? next : null;
  return typeof next === "string" && next !== (row.value ?? "") ? next : null;
}

/** The note shown after a feature change: a running agent picks it up on the next turn. */
export function turnNote(status: string | null | undefined): string {
  return status === "running" ? "Applies from the next turn." : "";
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
