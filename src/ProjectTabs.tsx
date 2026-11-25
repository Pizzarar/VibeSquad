// Shared Code | Storybook segmented pill (docs/PLAN_CODE_STORYBOOK_TABS.md, idea-834 = PLAN_STORYBOOK_V1 F3).
// Code = today's Normal project view; Storybook = openStorybook(id, name). Code from Storybook closes with user-Back
// semantics (closeStorybook() with no mode). Reused in the Normal topbar (BoringAde) and Storybook's sb-head; styled
// like the Buddy/Lead switcher pills (boring-switch-pill).
import { closeStorybook, openStorybook } from "./StorybookView";

export type ProjectTab = "code" | "storybook";

export function ProjectTabs({ projectId, name, active }: { projectId: string; name?: string; active: ProjectTab }) {
  return (
    <div className="project-tabs" role="group" aria-label="Workspace">
      <button
        type="button"
        className={`boring-switch-pill ${active === "code" ? "on" : ""}`}
        aria-pressed={active === "code"}
        data-testid="project-tab-code"
        onClick={() => { if (active !== "code") closeStorybook(); }}
      >
        Code
      </button>
      <button
        type="button"
        className={`boring-switch-pill ${active === "storybook" ? "on" : ""}`}
        aria-pressed={active === "storybook"}
        data-testid="project-tab-storybook"
        onClick={() => { if (active !== "storybook") openStorybook(projectId, name); }}
      >
        Storybook
      </button>
    </div>
  );
}
