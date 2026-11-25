// Crunch mode toggle (PLAN_CRUNCH_MODE C3). One source of truth: the Squad's `vibeMode` field in the teams registry.
// Normal topbar pill, Psycho toolbar chip and Team Settings checkbox all read/write it through these helpers, so one
// click flips it and the other two update via useTeams().
import { getTeams, saveTeams, useTeams } from "./teams";

export const CRUNCH_LABEL = "Crunch mode";
export const CRUNCH_COPY =
  "Lanes act on their leans until there's a tryable build; stops only for deletes, releases, money, outward actions.";
export const CRUNCH_TOOLTIP = `${CRUNCH_LABEL}: ${CRUNCH_COPY}`;

/** Subscribes to the registry and returns whether Crunch mode is on for this Squad. */
export function useCrunchMode(teamId: string | null | undefined): boolean {
  useTeams();
  return !!teamId && getTeams().find((t) => t.id === teamId)?.vibeMode === true;
}

export function setCrunchMode(teamId: string, on: boolean): Promise<unknown> {
  return saveTeams((cur) => cur.map((t) => (t.id === teamId ? { ...t, vibeMode: on } : t)));
}

export function CrunchToggle({ teamId, variant }: { teamId: string; variant: "boring" | "psycho" }) {
  const on = useCrunchMode(teamId);
  if (!getTeams().some((t) => t.id === teamId)) return null; // Unassigned/hub pseudo-teams have no registry row to save to
  const flip = () => void setCrunchMode(teamId, !on);
  const title = `${CRUNCH_TOOLTIP} Click to turn ${on ? "off" : "on"}.`;
  if (variant === "psycho") {
    return (
      <button className={`tchip${on ? " on" : ""}`} data-testid="crunch-toggle" aria-pressed={on} title={title} onClick={flip}>
        Crunch {on ? "on" : "off"}
      </button>
    );
  }
  return (
    <button type="button" className={`boring-switch-pill boring-crunch-pill${on ? " on" : ""}`} data-testid="crunch-toggle" aria-pressed={on} title={title} onClick={flip}>
      Crunch
    </button>
  );
}
