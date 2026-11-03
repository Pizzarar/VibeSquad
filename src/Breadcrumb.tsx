// Clickable top-bar breadcrumb for the chat → squad page → Squads Home ladder (docs/PLAN_SQUADS_HOME.md §H1).
import { Fragment } from "react";
import { breadcrumbOf } from "./pinFocusLogic";
import { enterSquadsHome, exitSquadsHome } from "./pinFocus";
import { setFullView } from "./PinGrid";
import { setFocus } from "./panes";

/** Always lands on Squads Home, even from FULL, focus or split. */
function goSquadsHome() {
  setFullView(false);
  setFocus(false);
  enterSquadsHome();
}

export function TopBreadcrumb(props: { squadsHome: boolean; squadId: string; squadName: string; laneName: string | null; hub?: boolean; onSelectSquad: (id: string) => void }) {
  const crumbs = breadcrumbOf(props);
  return (
    <nav className="top-breadcrumb" aria-label="Breadcrumb" data-testid="top-breadcrumb">
      {crumbs.map((c, i) => (
        <Fragment key={c.key}>
          {i > 0 && <span className="breadcrumb-sep">›</span>}
          <button
            type="button"
            className={`breadcrumb-seg ${c.key === "brainstorm" ? "current" : ""}`}
            data-testid={`breadcrumb-${c.key}`}
            aria-current={c.key === "brainstorm" ? "page" : undefined}
            onClick={c.key === "squads" ? goSquadsHome : c.key === "squad" ? () => props.onSelectSquad(props.squadId) : undefined}
          >
            {c.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
