// New squad creation modal: add a local folder or clone a repo, auto-fill name, optionally start a Buddy.
import { useEffect, useMemo, useState } from "react";
import { daemonClient, DEMO } from "./paseo";
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

export function NewSquadModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (squadId: string, pin: Pin | null) => void;
}) {
  const [source, setSource] = useState<"path" | "clone">("path");
  const [folderPath, setFolderPath] = useState("");
  const [cloneRepo, setCloneRepo] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [squadName, setSquadName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [startBuddy, setStartBuddy] = useState(true);
  const [selectedProfile, setSelectedProfile] = useState(DEFAULT_PIN_PROFILE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const { profiles } = useProfiles();
  const bsProfiles = useMemo(() => {
    const bs = profiles.filter((p) => p.role === "brainstorm");
    return bs.length > 0 ? bs : [{ name: "Brainstorm - Claude" }, { name: "Brainstorm - Gemini" }];
  }, [profiles]);

  const remote = isRemote();
  const rawPath =
    source === "path" ? folderPath : cloneDest || cloneRepo.split("/").pop()?.replace(/\.git$/, "") || "";
  const derived = useMemo(() => deriveSquadNameFromPath(rawPath), [rawPath]);

  useEffect(() => {
    if (!nameEdited && !remote) setSquadName(derived.name);
  }, [derived.name, nameEdited, remote]);

  const canSubmit = remote
    ? squadName.trim().length > 0
    : source === "path"
      ? folderPath.trim().length > 0
      : cloneRepo.trim().length > 0;

  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      let finalPath = folderPath.trim();
      if (!remote) {
        if (source === "clone") {
          const dest = cloneDest.trim() || cloneRepo.trim().split("/").pop()!.replace(/\.git$/, "");
          if (!DEMO) {
            const res = await (daemonClient as any).cloneGithubProject({ repo: cloneRepo.trim(), targetDirectory: dest });
            finalPath = (res as { path?: string }).path ?? dest;
          } else {
            finalPath = dest;
          }
        } else {
          if (!DEMO) await (daemonClient as any).addProject(finalPath);
        }
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
        lastProfile: startBuddy ? selectedProfile : undefined,
      });
      let newTeam: TeamDef = builtTeam;
      if (remote) {
        const { paths: _paths, path: _path, ...restTeam } = builtTeam as TeamDef & { path?: unknown };
        newTeam = {
          ...restTeam,
          lanes: builtTeam.lanes.map(({ paths: _lp, path: _lpath, ...restLane }: any) => restLane),
        } as unknown as TeamDef;
      }
      await saveTeams([...teams, newTeam]);

      let pin: Pin | null = null;
      if (startBuddy && newTeam.lanes[0]) {
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
      onCreated(newTeam.id, pin);
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
            {busy ? "…" : "Create"}
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
          <div className="seg" style={{ display: "flex", width: "100%", marginBottom: 12 }}>
            <button type="button" className={source === "path" ? "on" : ""} onClick={() => setSource("path")}>
              Folder path
            </button>
            <button type="button" className={source === "clone" ? "on" : ""} onClick={() => setSource("clone")}>
              Clone repo URL
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
            <>
              <div className="pin-idea-field">
                <label className="muted small">Repo URL or owner/repo</label>
                <input
                  value={cloneRepo}
                  placeholder="owner/repo or https://github.com/owner/repo"
                  style={{ width: "100%" }}
                  onChange={(e) => setCloneRepo(e.target.value)}
                />
              </div>
              <div className="pin-idea-field">
                <label className="muted small">Clone to (optional)</label>
                <input
                  value={cloneDest}
                  placeholder="Target directory name"
                  style={{ width: "100%" }}
                  onChange={(e) => setCloneDest(e.target.value)}
                />
              </div>
            </>
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
      {err && <div className="stat-alert small" style={{ marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
