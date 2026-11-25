// Crunch mode toggle (PLAN_CRUNCH_MODE C3). One source of truth: the Squad's `vibeMode` field in the teams registry.
// Normal topbar pill, Psycho toolbar chip, phone drawer row, palette command and Team Settings checkbox all read/write it
// through these helpers, so one click flips it and the others update via useTeams().
import { useCallback, useEffect, useRef, useState } from "react";
import { createCrunchSetter } from "./crunchMode";
import { getTeams, resetTeamsToDisk, saveTeams, useTeams } from "./teams";

export const CRUNCH_LABEL = "Crunch mode";
export const CRUNCH_COPY =
  "Lanes act on their leans until there's a tryable build; stops only for deletes, releases, money, outward actions.";
export const CRUNCH_TOOLTIP = `${CRUNCH_LABEL}: ${CRUNCH_COPY}`;

/** Subscribes to the registry and returns whether Crunch mode is on for this Squad. */
export function useCrunchMode(teamId: string | null | undefined): boolean {
  useTeams();
  return !!teamId && getTeams().find((t) => t.id === teamId)?.vibeMode === true;
}

/** Serialized per Squad; resolves false (after rolling the pill back) when the registry write failed. */
export const setCrunchMode = createCrunchSetter({
  save: (teamId, on) => saveTeams((cur) => cur.map((t) => (t.id === teamId ? { ...t, vibeMode: on } : t))),
  rollback: resetTeamsToDisk,
});

/** State + flip handler shared by every Crunch control: busy while saving, `failed` for a few seconds after a rolled-back save. */
export function useCrunchFlip(teamId: string) {
  const on = useCrunchMode(teamId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => setFailed(false), 4000);
    return () => clearTimeout(t);
  }, [failed]);
  const flip = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await setCrunchMode(teamId, !on);
    if (!alive.current) return;
    setBusy(false);
    if (!ok) setFailed(true);
  }, [busy, on, teamId]);
  return { on, busy, failed, flip };
}

export function CrunchToggle({ teamId, variant }: { teamId: string; variant: "boring" | "psycho" | "phone" }) {
  const { on, busy, failed, flip } = useCrunchFlip(teamId);
  const team = getTeams().find((t) => t.id === teamId);
  if (!team) return null; // Unassigned/hub pseudo-teams have no registry row to save to
  const state = on ? "on" : "off";
  const title = failed ? "Couldn't save Crunch mode, try again." : `${CRUNCH_TOOLTIP} Click to turn ${on ? "off" : "on"}.`;
  const common = { "data-testid": "crunch-toggle", "aria-pressed": on, "aria-busy": busy, "data-failed": failed || undefined, disabled: busy, title, onClick: () => void flip() } as const;
  if (variant === "psycho") {
    return <button {...common} className={`tchip${on ? " on" : ""}`}>{failed ? "Crunch: save failed" : `Crunch ${state}`}</button>;
  }
  if (variant === "phone") {
    return (
      <button {...common} type="button" className={`btn ghost phone-crunch-btn${on ? " on" : ""}`} data-testid="phone-crunch-btn">
        <span className="phone-crunch-label">{failed ? "Couldn't save · try again" : `Crunch mode ${state} · `}</span>
        {!failed && <span className="phone-crunch-name">{team.name}</span>}
      </button>
    );
  }
  return (
    <button {...common} type="button" className={`boring-switch-pill boring-crunch-pill${on ? " on" : ""}`}>
      {failed ? "Save failed" : `Crunch ${state}`}
    </button>
  );
}
