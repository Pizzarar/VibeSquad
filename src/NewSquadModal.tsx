// New squad creation modal: add a local folder or clone a GitHub repo (idea-343), auto-fill name, optionally start a Buddy.
import { useEffect, useMemo, useState } from "react";
import {
  getTeams,
  saveTeams,
  type TeamDef,
} from "./teams";
import { DEFAULT_PIN_PROFILE, slugLaneId, type Pin, type PinLane } from "./pins";
import { useProfiles } from "./profiles";
import { Modal } from "./TeamActions";
import { buildNewSquadTeamDef } from "./newSquadDef";
import { isRemote } from "./remoteSession";
import { DEMO } from "./demoFlag";

export function deriveSquadNameFromPath(rawPath: string): { id: string; name: string; pathMatcher: string } {
  const normalized = rawPath.replace(/\.git$/, "").replace(/[/\\]+$/, "");
  const parts = normalized.replace(/\\/g, "/").split("/");
  const folderSegment = parts.filter(Boolean).pop() ?? "";
  const titleCased = folderSegment
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  const id = slugLaneId(folderSegment || "new-squad");
  return { id, name: titleCased || "New Squad", pathMatcher: folderSegment };
}

export type GhRepo = { nameWithOwner: string; name: string; description: string; isPrivate: boolean; updatedAt: string };

const GH_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const ghSegmentOk = (s: string) => GH_SEGMENT.test(s) && !s.startsWith("-") && !s.startsWith(".");

/** Client mirror of server parseGithubRepoSpec (the server re-validates): "owner/repo" or a github.com URL -> "owner/repo". */
export function githubSpecFromInput(raw: string): string | null {
  const t = raw.trim();
  if (!t || /[\s\\]/.test(t)) return null;
  const m = /^https:\/\/(?:www\.)?github\.com\/(.*)$/i.exec(t);
  const path = m ? m[1].replace(/\/$/, "") : t;
  if (/[?#@%:]/.test(path)) return null;
  const parts = path.split("/");
  if (parts.length !== 2) return null;
  const repo = parts[1].toLowerCase().endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
  return ghSegmentOk(parts[0]) && ghSegmentOk(repo) ? `${parts[0]}/${repo}` : null;
}

const DEMO_GH_REPOS: GhRepo[] = [
  { nameWithOwner: "you/sports-ball-battles", name: "sports-ball-battles", description: "Arcade sports brawler", isPrivate: true, updatedAt: "2026-11-17T12:00:00Z" },
  { nameWithOwner: "you/my-app", name: "my-app", description: "Web app", isPrivate: false, updatedAt: "2026-11-10T12:00:00Z" },
  { nameWithOwner: "your-org/website", name: "website", description: "", isPrivate: false, updatedAt: "2026-10-30T12:00:00Z" },
];

export const GH_SERVER_TOO_OLD = "This VibeSquad server doesn't support GitHub import yet — restart VibeSquad";

/** Message for a failed gh-repos / gh-clone response. A 404/405 without a real GitError body means the route is missing (old server). */
export function ghHttpError(status: number, body: { error?: string } | null): string {
  const msg = typeof body?.error === "string" ? body.error : "";
  if ((status === 404 || status === 405) && (!msg || msg.toLowerCase() === "not found")) return GH_SERVER_TOO_OLD;
  return msg || `GitHub request failed (${status})`;
}

/** Each error renders once: load errors in the status box under the repo field, submit errors in the pink line above Create. */
export function ghErrorSlots(loadErr: string, submitErr: string): { status: string; submit: string } {
  return { status: loadErr, submit: submitErr && submitErr !== loadErr ? submitErr : "" };
}

async function ghJson<T>(res: Response): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(ghHttpError(res.status, j));
  return j as T;
}
const fetchGhRepos = () => fetch("/__vibesquad/git/gh-repos").then((r) => ghJson<{ repos: GhRepo[]; projectsDir: string }>(r));
const cloneGhRepo = (repo: string) =>
  fetch("/__vibesquad/git/gh-clone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo }) }).then((r) =>
    ghJson<{ ok: true; path: string; reused: boolean }>(r),
  );

export function NewSquadModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (squadId: string, pin: Pin | null) => void;
}) {
  const [folderPath, setFolderPath] = useState("");
  const [squadName, setSquadName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [startBuddy, setStartBuddy] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState(DEFAULT_PIN_PROFILE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [source, setSource] = useState<"path" | "github">("path");
  const [ghQuery, setGhQuery] = useState("");
  const [ghPicked, setGhPicked] = useState<string | null>(null);
  const [ghRepos, setGhRepos] = useState<GhRepo[] | null>(null);
  const [ghDir, setGhDir] = useState("");
  const [ghErr, setGhErr] = useState("");

  const { profiles } = useProfiles();
  const bsProfiles = useMemo(() => {
    const bs = profiles.filter((p) => p.role === "brainstorm");
    return bs.length > 0 ? bs : [{ name: "Brainstorm - Claude" }, { name: "Brainstorm - Gemini" }];
  }, [profiles]);

  const remote = isRemote();
  const github = !remote && source === "github";
  // Tab-active flags live outside className so the CSS-class scan never reads "path"/"github" as classes.
  const pathTabActive = source === "path";
  const githubTabActive = source === "github";
  // The repo to clone: a picked row, else the typed text when it reads as owner/repo or a GitHub URL.
  const ghSpec = ghPicked ?? githubSpecFromInput(ghQuery);
  const rawPath = github ? (ghSpec?.split("/")[1] ?? "") : folderPath;
  const derived = useMemo(() => deriveSquadNameFromPath(rawPath), [rawPath]);

  useEffect(() => {
    if (!nameEdited && !remote) setSquadName(derived.name);
  }, [derived.name, nameEdited, remote]);

  // Fetch the repo list once, the first time the From GitHub tab opens (DEMO: canned rows, no live call).
  useEffect(() => {
    if (!github || ghRepos !== null) return;
    if (DEMO) {
      setGhRepos(DEMO_GH_REPOS);
      setGhDir("C:\\Users\\you\\projects");
      return;
    }
    let live = true;
    setGhErr("");
    fetchGhRepos().then(
      (r) => {
        if (!live) return;
        setGhRepos(Array.isArray(r.repos) ? r.repos : []);
        setGhDir(r.projectsDir ?? "");
      },
      (e) => {
        if (!live) return;
        setGhRepos([]);
        setGhErr(String((e as Error)?.message ?? e));
      },
    );
    return () => {
      live = false;
    };
  }, [github, ghRepos]);

  const ghMatches = useMemo(() => {
    const q = ghQuery.trim().toLowerCase();
    const list = ghRepos ?? [];
    return q && !ghPicked ? list.filter((r) => r.nameWithOwner.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)) : list;
  }, [ghRepos, ghQuery, ghPicked]);

  const errSlots = ghErrorSlots(github ? ghErr : "", err);
  const canSubmit = remote ? squadName.trim().length > 0 : github ? ghSpec !== null : folderPath.trim().length > 0;

  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      let finalPath = folderPath.trim();
      if (github) {
        if (!ghSpec) throw new Error("Pick a repo or enter owner/repo");
        // The server validates the spec again, clones into the projects folder (or reuses that repo's checkout) and returns the path.
        finalPath = DEMO ? ghSpec.split("/")[1] : (await cloneGhRepo(ghSpec)).path;
      }

      const teams = getTeams();
      const base = `team-${(squadName.trim() || "new").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      const taken = new Set(teams.map((t) => t.id));
      let teamId = base;
      let n = 2;
      while (taken.has(teamId)) teamId = `${base}-${n++}`;

      const builtTeam = buildNewSquadTeamDef({
        id: teamId,
        name: squadName.trim() || "New Squad",
        folderPath: finalPath,
        existingTeams: teams,
        lastProfile: !remote && startBuddy ? selectedProfile : undefined,
      });
      let newTeam: TeamDef = builtTeam;
      if (remote) {
        const { paths: _paths, path: _path, ...restTeam } = builtTeam as TeamDef & { path?: unknown };
        newTeam = {
          ...restTeam,
          lanes: builtTeam.lanes.map(
            ({ paths: _lp, path: _lpath, lastProfile: _lastProfile, ...restLane }: any) => restLane,
          ),
        } as unknown as TeamDef;
      }
      await saveTeams([...teams, newTeam]);

      let pin: Pin | null = null;
      if (!remote && startBuddy && newTeam.lanes[0]) {
        const lane = newTeam.lanes[0] as PinLane;
        pin = {
          squad: newTeam,
          lane,
          state: "pinned",
          order: 0,
          brainstorm: null,
          lead: null,
          workers: [],
          needsYou: 0,
          running: 0,
          contextUsed: 0,
          topicBrainstorms: [],
        };
      }
      onCreated(newTeam.id, remote ? null : pin);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="NEW SQUAD"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn ok"
            data-testid="new-squad-submit"
            disabled={busy || !canSubmit}
            onClick={() => void create()}
          >
            {busy ? (github ? "Cloning…" : "…") : "Create"}
          </button>
        </>
      }
    >
      {remote ? (
        <p className="muted small" data-testid="new-squad-remote-note">
          Remote mode: creates a squad entry on the host; folder paths are configured on the PC
        </p>
      ) : (
        <>
          <div className="seg" role="tablist" aria-label="Project source" style={{ marginBottom: 10 }}>
            <button
              type="button"
              role="tab"
              data-testid="new-squad-source-path"
              className={pathTabActive ? "on" : ""}
              aria-selected={source === "path"}
              onClick={() => setSource("path")}
            >
              Local folder
            </button>
            <button
              type="button"
              role="tab"
              data-testid="new-squad-source-github"
              className={githubTabActive ? "on" : ""}
              aria-selected={source === "github"}
              onClick={() => setSource("github")}
            >
              From GitHub
            </button>
          </div>
          {source === "path" ? (
            <div className="pin-idea-field">
              <label className="muted small">Folder path</label>
              <input
                value={folderPath}
                placeholder="C:\Users\you\projects\my-app"
                style={{ width: "100%" }}
                onChange={(e) => setFolderPath(e.target.value)}
              />
            </div>
          ) : (
            <div className="pin-idea-field">
              <label className="muted small" htmlFor="new-squad-github-input">
                GitHub repo
              </label>
              <input
                id="new-squad-github-input"
                data-testid="new-squad-github-input"
                value={ghQuery}
                placeholder="Search your repos or paste owner/repo…"
                style={{ width: "100%" }}
                autoFocus
                onChange={(e) => {
                  setGhPicked(null);
                  setGhQuery(e.target.value);
                }}
              />
              <div
                data-testid="new-squad-github-list"
                role="listbox"
                aria-label="Your GitHub repos"
                style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line)", background: "var(--well)", marginTop: 6 }}
              >
                {ghRepos === null ? (
                  <div className="muted small" style={{ padding: "6px 8px" }}>
                    Loading your repos…
                  </div>
                ) : ghMatches.length === 0 ? (
                  <div className="muted small" style={{ padding: "6px 8px" }}>
                    {ghErr || (ghSpec ? `Will clone ${ghSpec}` : "No matching repos. Paste owner/repo or a GitHub URL.")}
                  </div>
                ) : (
                  ghMatches.map((r) => (
                    <button
                      key={r.nameWithOwner}
                      type="button"
                      role="option"
                      aria-selected={ghPicked === r.nameWithOwner}
                      data-testid={`new-squad-github-repo-${r.nameWithOwner}`}
                      onClick={() => {
                        setGhPicked(r.nameWithOwner);
                        setGhQuery(r.nameWithOwner);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "5px 8px",
                        border: 0,
                        borderBottom: "1px solid var(--line)",
                        cursor: "pointer",
                        background: ghPicked === r.nameWithOwner ? "var(--violet-dim)" : "transparent",
                        color: "var(--text)",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{r.nameWithOwner}</span>
                        {r.isPrivate && <span className="badge">private</span>}
                      </span>
                      {r.description && (
                        <span className="muted small" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.description}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
              {ghDir && (
                <div className="muted small" style={{ marginTop: 4 }} data-testid="new-squad-github-dest">
                  Clones into {ghDir}
                  {ghSpec ? `\\${ghSpec.split("/")[1]}` : ""} (an existing checkout of the same repo is reused)
                </div>
              )}
            </div>
          )}
        </>
      )}
      <div className="pin-idea-field">
        <label className="muted small" htmlFor="new-squad-name-input">
          Squad name
        </label>
        <input
          id="new-squad-name-input"
          data-testid="new-squad-name"
          value={squadName}
          placeholder="Squad name (auto-filled)"
          style={{ width: "100%" }}
          onChange={(e) => {
            setSquadName(e.target.value);
            setNameEdited(true);
          }}
        />
      </div>
      {!remote && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px", cursor: "pointer" }}>
            <input
              type="checkbox"
              data-testid="new-squad-start-buddy"
              checked={startBuddy}
              onChange={(e) => setStartBuddy(e.target.checked)}
            />
            <span>Start a Buddy</span>
          </label>
          {startBuddy && (
            <div className="pin-profile-chips" data-testid="new-squad-profile-chips">
              {bsProfiles.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  data-testid={`new-squad-profile-${p.name}`}
                  className={`tchip ${selectedProfile === p.name ? "on" : ""}`}
                  aria-pressed={selectedProfile === p.name}
                  onClick={() => setSelectedProfile(p.name)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {errSlots.submit && <div className="stat-alert small" style={{ marginTop: 8 }}>{errSlots.submit}</div>}
    </Modal>
  );
}
