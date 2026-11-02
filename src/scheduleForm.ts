// Pure helpers for the Schedules create/edit form: validation and form -> daemon request mapping.
// No React, DOM or daemon imports, so node --test can load this file directly.

export type CadenceKind = "cron" | "every";
export type TargetKind = "new-agent" | "agent" | "self";
export type IntervalUnit = "s" | "m" | "h" | "d";

export interface ScheduleForm {
  name: string;
  prompt: string;
  cadenceKind: CadenceKind;
  cron: string;
  timezone: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  targetKind: TargetKind;
  agentId: string;
  provider: string;
  cwd: string;
  model: string;
  maxRuns: string;
  expiresAt: string;
  runOnCreate: boolean;
}

export const EMPTY_FORM: ScheduleForm = {
  name: "",
  prompt: "",
  cadenceKind: "cron",
  cron: "0 9 * * *",
  timezone: "",
  intervalValue: "30",
  intervalUnit: "m",
  targetKind: "new-agent",
  agentId: "",
  provider: "claude",
  cwd: "",
  model: "",
  maxRuns: "",
  expiresAt: "",
  runOnCreate: false,
};

const UNIT_MS: Record<IntervalUnit, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNITS_DESC: IntervalUnit[] = ["d", "h", "m", "s"];
const MIN_EVERY_MS = 10_000;
const FIELD_RANGES: Array<[string, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 6],
];

function validateCronField(src: string, label: string, min: number, max: number): string | null {
  for (const part of src.split(",")) {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined) return `${label}: bad step in "${part}"`;
    if (step !== undefined && !/^\d+$/.test(step)) return `${label}: bad step in "${part}"`;
    if (step !== undefined && Number(step) < 1) return `${label}: step must be at least 1`;
    if (range === "*") continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(range);
    if (!m) return `${label}: cannot read "${part}"`;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (step !== undefined && m[2] === undefined) return `${label}: a step needs "*" or a range, not a single number, in "${part}"`;
    if (lo < min || hi > max) return `${label}: ${part} is outside ${min}-${max}`;
    if (lo > hi) return `${label}: range ${part} runs backwards`;
  }
  return null;
}

/** Null when the 5-field cron expression looks valid, else a short reason. */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return "Cron needs 5 fields: minute hour day-of-month month day-of-week";
  for (let i = 0; i < 5; i++) {
    const [label, min, max] = FIELD_RANGES[i];
    const bad = validateCronField(fields[i], label, min, max);
    if (bad) return bad;
  }
  return null;
}

export function intervalToMs(value: string, unit: IntervalUnit): number | null {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const ms = Math.round(Number(value) * UNIT_MS[unit]);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export function formatEveryMs(ms: number): string {
  for (const u of UNITS_DESC) {
    if (ms % UNIT_MS[u] === 0) return `every ${ms / UNIT_MS[u]}${u}`;
  }
  return `every ${ms}ms`;
}

export function cadenceLabel(c: any): string {
  if (typeof c === "string") return c;
  if (c?.type === "every") return formatEveryMs(Number(c.everyMs));
  return c?.expression ?? "";
}

/** One message per problem; empty means the form can be submitted. */
export function validateForm(f: ScheduleForm, mode: "create" | "edit" = "create"): string[] {
  const errs: string[] = [];
  if (!f.prompt.trim()) errs.push("Prompt is required");
  if (f.cadenceKind === "cron") {
    const bad = validateCron(f.cron);
    if (bad) errs.push(bad);
  } else {
    const ms = intervalToMs(f.intervalValue, f.intervalUnit);
    if (ms === null) errs.push("Interval must be a positive number");
    else if (ms < MIN_EVERY_MS) errs.push("Interval must be at least 10 seconds");
  }
  if (mode === "create") {
    if (f.targetKind === "new-agent" && !f.cwd.trim()) errs.push("Working directory is required for a new agent");
    if (f.targetKind === "new-agent" && !f.provider.trim()) errs.push("Provider is required for a new agent");
    if (f.targetKind !== "new-agent" && !f.agentId.trim()) errs.push("Pick an agent");
  }
  if (f.maxRuns.trim() && (!/^[1-9]\d*$/.test(f.maxRuns.trim()) || !Number.isSafeInteger(Number(f.maxRuns)))) errs.push("Max runs must be a whole number of 1 or more");
  if (f.expiresAt.trim() && Number.isNaN(Date.parse(f.expiresAt))) errs.push("Expiry is not a valid date");
  return errs;
}

function cadenceOf(f: ScheduleForm) {
  return f.cadenceKind === "cron"
    ? {
        type: "cron" as const,
        expression: f.cron.trim().replace(/\s+/g, " "),
        ...(f.timezone.trim() ? { timezone: f.timezone.trim() } : {}),
      }
    : { type: "every" as const, everyMs: intervalToMs(f.intervalValue, f.intervalUnit) as number };
}

const isoOrUndef = (s: string) => (s.trim() ? new Date(s).toISOString() : undefined);

export function toCreateRequest(f: ScheduleForm) {
  const target =
    f.targetKind === "new-agent"
      ? {
          type: "new-agent" as const,
          config: { provider: f.provider.trim(), cwd: f.cwd.trim(), ...(f.model.trim() ? { model: f.model.trim() } : {}) },
        }
      : { type: f.targetKind, agentId: f.agentId.trim() };
  const expiresAt = isoOrUndef(f.expiresAt);
  return {
    prompt: f.prompt.trim(),
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    cadence: cadenceOf(f),
    target,
    ...(f.maxRuns.trim() ? { maxRuns: Number(f.maxRuns) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(f.runOnCreate ? { runOnCreate: true } : {}),
  };
}

/** Update sends name/prompt/cadence/limits only; null clears name, maxRuns and expiry. */
export function toUpdateRequest(id: string, f: ScheduleForm) {
  return {
    id,
    name: f.name.trim() ? f.name.trim() : null,
    prompt: f.prompt.trim(),
    cadence: cadenceOf(f),
    maxRuns: f.maxRuns.trim() ? Number(f.maxRuns) : null,
    expiresAt: isoOrUndef(f.expiresAt) ?? null,
  };
}

/** Prefill the edit form from a stored schedule (list/inspect row). */
export function formFromSchedule(s: any): ScheduleForm {
  const c = s?.cadence;
  const t = s?.target;
  const every = c?.type === "every";
  let value = EMPTY_FORM.intervalValue;
  let unit: IntervalUnit = EMPTY_FORM.intervalUnit;
  if (every) {
    const ms = Number(c.everyMs);
    unit = UNITS_DESC.find((u) => ms % UNIT_MS[u] === 0) ?? "s";
    value = String(ms / UNIT_MS[unit]);
  }
  return {
    ...EMPTY_FORM,
    name: s?.name ?? "",
    prompt: s?.prompt ?? "",
    cadenceKind: every ? "every" : "cron",
    cron: every ? EMPTY_FORM.cron : typeof c === "string" ? c : (c?.expression ?? EMPTY_FORM.cron),
    timezone: c?.timezone ?? "",
    intervalValue: value,
    intervalUnit: unit,
    targetKind: t?.type ?? "new-agent",
    agentId: t?.agentId ?? "",
    provider: t?.config?.provider ?? EMPTY_FORM.provider,
    cwd: t?.config?.cwd ?? "",
    model: t?.config?.model ?? "",
    maxRuns: s?.maxRuns ? String(s.maxRuns) : "",
    expiresAt: s?.expiresAt ? toLocalInput(s.expiresAt) : "",
  };
}

export const isHeartbeat = (s: any): boolean => s?.target?.type === "self";

/** ISO timestamp -> value for <input type="datetime-local"> in the viewer's local time. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
