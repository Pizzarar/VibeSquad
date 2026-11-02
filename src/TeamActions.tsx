import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultSpawnConfigFor } from "./antigravity";
import { daemonClient, DEMO, spawnTeamAgent, usePaseo } from "./paseo";
import {
  checkBuddyOverlap,
  getTeams,
  resolve,
  saveTeams,
  slugifyFeatureLane,
  titleFor,
  type BuddyOverlapLogEntry,
  type TeamDef,
  type TeamView,
} from "./teams";
import { useDraft } from "./drafts";
import { findProfile, getProfiles, useProfiles, type Profile, type Role } from "./profiles";

export { TeamSettingsModal, ProfileImportModal, ARCHETYPES } from "./TeamSettingsModal";
export { findProfile, getProfiles, useProfiles, type Profile, type Role };

export const TITLE_LIMIT = 60;

export type NameInput = {
  team: string;
  laneId: string;
  laneName: string;
  role: Role;
  profile: string;
  ord: string;
  topic: string;
  task: string;
  job: string;
};

/** Naming Standard v1 (docs/NAMING.md): labels are the source of truth, the title is generated. */
export function buildName(i: NameInput): { title: string; labels: Record<string, string> } {
  const labels: Record<string, string> = { team: i.team };
  if (i.laneId) {
    labels.lane = i.laneId;
    labels.lead = i.laneId;
  }
  labels.role = i.role;
  labels.profile = i.profile;
  const LANE_ = i.laneName || i.laneId;
  if (i.role === "lead") {
    if (i.ord) labels.ord = i.ord;
  } else if (i.role === "brainstorm") {
    if (i.topic.trim()) labels.topic = i.topic.trim();
  } else {
    labels.job = (i.job || "job").trim() || "job";
    if (i.task) labels.task = i.task;
  }
  const title = titleFor(i.role === "lead" || i.role === "brainstorm" ? i.role : "worker", LANE_, { ord: i.ord, topic: i.topic, job: i.job });
  return { title, labels };
}

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const { onClose } = props;
  const openerRef = useRef(document.activeElement as HTMLElement | null); // render-time: before autoFocus children run
  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      const cur = document.activeElement;
      const stranded = !cur || cur === document.body || !!cur.closest?.(".modal-back"); // don't steal focus a jump/action already moved
      if (stranded && opener && opener.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${props.wide ? "wide" : ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <span>{props.title}</span>
          <button className="btn ghost small" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
  </label>
);

export function NewAgentModal({ view, onClose, onCreated }: { view: TeamView; onClose: () => void; onCreated: (id: string) => void }) {
  const { workspaces } = usePaseo();
  const { profiles, installedProviders } = useProfiles();
  const team = view.team;
  const [profileName, setProfileName] = useState("Implement - Sonnet");
  const profile = findProfile(profileName, profiles) ?? profiles[0]!;
  const [role, setRole] = useState<Role>(profile.role);
  const [laneId, setLaneId] = useState(team.lanes[0]?.id ?? "");
  const [ord, setOrd] = useState("1");
  const [topic, setTopic, clearTopic] = useDraft(`new-agent:${team.id}:topic`);
  const [task, setTask] = useState("");
  const [job, setJob] = useState("");
  const [promptDraft, setPrompt, clearPrompt] = useDraft(`new-agent:${team.id}:${profileName}:prompt`);
  const prompt = promptDraft || profile.brief;
  const [cwd, setCwd] = useState("");
  const [newWt, setNewWt] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Directory suggestions
  const [cwdSugs, setCwdSugs] = useState<string[]>([]);
  const cwdSugTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add project / clone drawer
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectPath, setAddProjectPath] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [cloneRepo, setCloneRepo] = useState("");
  const [cloneDest, setCloneDest] = useState("");
  const [cloning, setCloning] = useState(false);
  const [addProjectErr, setAddProjectErr] = useState("");

  // Worktree picker
  type WorktreeEntry = { worktreePath: string; branchName?: string | null };
  const [existingWts, setExistingWts] = useState<WorktreeEntry[]>([]);
  const [wtMode, setWtMode] = useState<"none" | "existing" | "new">("none");
  const [selectedWt, setSelectedWt] = useState("");

  const fetchSuggestions = useCallback(async (query: string) => {
    if (!query || DEMO) { setCwdSugs([]); return; }
    try {
      const res = await daemonClient.getDirectorySuggestions({ query, includeDirectories: true, includeFiles: false, limit: 8 });
      setCwdSugs(res.directories ?? []);
    } catch { setCwdSugs([]); }
  }, []);

  const onCwdChange = (val: string) => {
    setCwd(val);
    if (cwdSugTimer.current) clearTimeout(cwdSugTimer.current);
    cwdSugTimer.current = setTimeout(() => void fetchSuggestions(val), 250);
  };

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    async function loadWts() {
      try {
        if (DEMO) { setExistingWts([]); return; }
        const res = await daemonClient.getPaseoWorktreeList({ cwd });
        if (!cancelled) setExistingWts(res.worktrees ?? []);
      } catch { if (!cancelled) setExistingWts([]); }
    }
    loadWts();
    return () => { cancelled = true; };
  }, [cwd]);

  const addLocalProject = async () => {
    if (!addProjectPath.trim()) return;
    setAddingProject(true);
    setAddProjectErr("");
    try {
      if (!DEMO) await daemonClient.addProject(addProjectPath.trim());
      await saveTeams((cur) =>
        cur.map((t) =>
          t.id === team.id && !t.paths.includes(addProjectPath.trim())
            ? { ...t, paths: [...t.paths, addProjectPath.trim()] }
            : t,
        ),
      );
      setCwd(addProjectPath.trim());
      setAddProjectOpen(false);
      setAddProjectPath("");
    } catch (e) {
      setAddProjectErr(String(e));
    } finally {
      setAddingProject(false);
    }
  };

  const cloneProject = async () => {
    if (!cloneRepo.trim()) return;
    setCloning(true);
    setAddProjectErr("");
    try {
      const dest = cloneDest.trim() || cloneRepo.trim().split("/").pop()!.replace(/\.git$/, "");
      let clonedPath = dest;
      if (!DEMO) {
        const res = await daemonClient.cloneGithubProject({ repo: cloneRepo.trim(), targetDirectory: dest });
        clonedPath = (res as { path?: string }).path ?? dest;
      }
      setCwd(clonedPath);
      setAddProjectOpen(false);
      setCloneRepo("");
      setCloneDest("");
    } catch (e) {
      setAddProjectErr(String(e));
    } finally {
      setCloning(false);
    }
  };

  const dirs = useMemo(() => {
    const set = new Set<string>();
    for (const m of view.members) if (m.agent.status !== "closed") set.add(m.agent.cwd);
    const needles = team.paths.map((p) => p.toLowerCase().replace(/-$/, ""));
    for (const w of workspaces.values()) {
      const d = (w as { workspaceDirectory?: string; directory?: string }).workspaceDirectory ?? (w as { directory?: string }).directory;
      if (d && needles.some((n) => d.toLowerCase().includes(n))) set.add(d);
    }
    return [...set];
  }, [view, workspaces, team]);
  useEffect(() => {
    if (!cwd && dirs[0]) setCwd(dirs[0]);
  }, [dirs, cwd]);

  const pickProfile = (name: string) => {
    const p = findProfile(name, profiles) ?? profiles[0]!;
    setProfileName(p.name);
    setRole(p.role);
  };

  const lane = team.lanes.find((l) => l.id === laneId);
  const { title, labels } = buildName({
    team: team.id,
    laneId,
    laneName: lane?.name ?? laneId,
    role,
    profile: profile.name,
    ord,
    topic,
    task,
    job,
  });
  const defaults = defaultSpawnConfigFor(profile.provider);
  const modeId = profile.modeId ?? defaults.modeId;
  const isProviderInstalled = installedProviders.includes(profile.provider);
  const badges: [string, string][] = [["provider/model", `${profile.provider}/${profile.model}`]];
  if (modeId) badges.push(["modeId", modeId]);
  if (profile.thinkingOptionId) badges.push(["thinkingOptionId", profile.thinkingOptionId]);
  if (profile.featureValues && Object.keys(profile.featureValues).length > 0) {
    for (const [k, v] of Object.entries(profile.featureValues)) {
      badges.push([k, String(v)]);
    }
  } else {
    if (defaults.approvalPolicy) badges.push(["approvalPolicy", defaults.approvalPolicy]);
    if (defaults.sandbox) badges.push(["sandbox", defaults.sandbox]);
    badges.push(["shareMcp", String(defaults.shareMcp)]);
  }

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await spawnTeamAgent({
        provider: profile.provider,
        model: profile.model,
        modeId,
        thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues,
        notes: profile.notes,
        approvalPolicy: defaults.approvalPolicy,
        sandbox: defaults.sandbox,
        shareMcp: defaults.shareMcp,
        title,
        labels,
        prompt,
        cwd,
        worktree: newWt && branch ? { branch } : undefined,
      });
      clearTopic();
      clearPrompt();
      onCreated(r.id);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy &&
    !!cwd &&
    !!laneId &&
    (!newWt || !!branch) &&
    !(role === "worker" && (!task || !job)) &&
    title.length <= TITLE_LIMIT &&
    !(wtMode === "existing" && !selectedWt);

  return (
    <Modal
      title={`NEW AGENT · ${team.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          {err && <span className="stat-alert small">{err}</span>}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn ok" disabled={!canSubmit} onClick={submit}>
            {busy ? "Spawning…" : "Spawn agent"}
          </button>
        </>
      }
    >
      <div className="na-grid">
        <div className="na-col">
          <Field label="PROFILE">
            <select value={profile.name} onChange={(e) => pickProfile(e.target.value)}>
              {profiles.map((p) => {
                const inst = installedProviders.includes(p.provider);
                return (
                  <option key={p.name} value={p.name} style={inst ? undefined : { opacity: 0.55 }}>
                    {inst ? p.name : `${p.name} (install ${p.provider})`}
                  </option>
                );
              })}
            </select>
          </Field>
          {!isProviderInstalled && (
            <div className="stat-alert small" data-testid="missing-provider-badge">
              Provider not installed: install {profile.provider}
            </div>
          )}
          <div className="spawn-defaults" title="Applied at spawn (A1/A6)">
            {badges.map(([k, v]) => (
              <span key={k} className="def-badge">
                <b>{k}</b> {v}
              </span>
            ))}
          </div>
          <div className="row2">
            <Field label="ROLE">
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="lead">lead</option>
                <option value="brainstorm">brainstorm</option>
                <option value="worker">worker</option>
              </select>
            </Field>
            <Field label="TEAM">
              <select value={laneId} onChange={(e) => setLaneId(e.target.value)}>
                {team.lanes.length === 0 && <option value="">(no teams)</option>}
                {team.lanes.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {role === "lead" && (
            <Field label="ORD">
              <input value={ord} onChange={(e) => setOrd(e.target.value.replace(/\D/g, ""))} />
            </Field>
          )}
          {role === "brainstorm" && (
            <Field label="TOPIC">
              <input value={topic} placeholder="neon-noir cast" onChange={(e) => setTopic(e.target.value)} />
            </Field>
          )}
          {role === "worker" && (
            <div className="row2">
              <Field label="TASK">
                <input value={task} placeholder="task-id" onChange={(e) => setTask(e.target.value)} />
              </Field>
              <Field label="JOB">
                <input value={job} placeholder="short job name" onChange={(e) => setJob(e.target.value)} />
              </Field>
            </div>
          )}
          <div className="preview">
            <div className="field-label">TITLE PREVIEW</div>
            <div className="preview-title">{title}</div>
            <div className={`small ${title.length > TITLE_LIMIT ? "stat-alert" : "muted"}`}>
              {title.length}/{TITLE_LIMIT} chars{title.length > TITLE_LIMIT ? " · too long, shorten the job" : ""}
            </div>
            <div className="field-label">LABELS</div>
            <div className="pills">
              {Object.entries(labels).map(([k, v]) => (
                <span key={k} className="label-pill">
                  {k}={v}
                </span>
              ))}
            </div>
          </div>
          <Field label="WORKSPACE">
            <>
              <input
                list="na-cwd-suggestions"
                value={cwd}
                placeholder="Project directory…"
                onChange={(e) => onCwdChange(e.target.value)}
              />
              <datalist id="na-cwd-suggestions" data-testid="cwd-suggestions">
                {[...new Set([...dirs, ...cwdSugs])].map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </>
          </Field>
          <button
            className="btn ghost small"
            data-testid="add-project-toggle"
            style={{ marginBottom: 4 }}
            onClick={() => { setAddProjectOpen((v) => !v); setAddProjectErr(""); }}
          >
            {addProjectOpen ? "▲ Close" : "+ Add folder / Clone repo"}
          </button>
          {addProjectOpen && (
            <div className="add-project-drawer" style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 8, marginBottom: 8 }}>
              {addProjectErr && <div className="stat-alert small">{addProjectErr}</div>}
              <Field label="LOCAL FOLDER PATH">
                <>
                  <input
                    value={addProjectPath}
                    placeholder="/path/to/my-project"
                    onChange={(e) => setAddProjectPath(e.target.value)}
                  />
                  <button
                    className="btn ok small"
                    disabled={addingProject || !addProjectPath.trim()}
                    onClick={() => void addLocalProject()}
                  >
                    {addingProject ? "Adding…" : "Add folder"}
                  </button>
                </>
              </Field>
              <div className="field-label" style={{ marginTop: 8 }}>CLONE GITHUB REPO</div>
              <input
                value={cloneRepo}
                placeholder="owner/repo or https://github.com/…"
                onChange={(e) => setCloneRepo(e.target.value)}
                style={{ marginBottom: 4 }}
              />
              <input
                value={cloneDest}
                placeholder="Destination path (optional)"
                onChange={(e) => setCloneDest(e.target.value)}
                style={{ marginBottom: 4 }}
              />
              <button
                className="btn ok small"
                data-testid="clone-repo-btn"
                disabled={cloning || !cloneRepo.trim()}
                onClick={() => void cloneProject()}
              >
                {cloning ? "Cloning…" : "Clone repo"}
              </button>
            </div>
          )}
          <div data-testid="worktree-picker" style={{ marginTop: 4 }}>
            <div className="field-label">WORKTREE / BRANCH</div>
            <div className="row2" style={{ gap: 6 }}>
              <label className="check small">
                <input
                  type="radio"
                  name="wt-mode"
                  checked={wtMode === "none"}
                  onChange={() => { setWtMode("none"); setNewWt(false); }}
                />{" "}
                Main checkout
              </label>
              {existingWts.length > 0 && (
                <label className="check small">
                  <input
                    type="radio"
                    name="wt-mode"
                    checked={wtMode === "existing"}
                    onChange={() => { setWtMode("existing"); setNewWt(false); setSelectedWt(existingWts[0]?.worktreePath ?? ""); }}
                  />{" "}
                  Existing worktree
                </label>
              )}
              <label className="check small">
                <input
                  type="radio"
                  name="wt-mode"
                  checked={wtMode === "new"}
                  onChange={() => { setWtMode("new"); setNewWt(true); }}
                />{" "}
                Create new worktree…
              </label>
            </div>
            {wtMode === "existing" && existingWts.length > 0 && (
              <select
                value={selectedWt}
                onChange={(e) => setSelectedWt(e.target.value)}
                style={{ marginTop: 4, width: "100%" }}
              >
                {existingWts.map((w) => (
                  <option key={w.worktreePath} value={w.worktreePath}>
                    {w.branchName ?? w.worktreePath}
                  </option>
                ))}
              </select>
            )}
            {wtMode === "new" && (
              <Field label="BRANCH NAME">
                <input value={branch} placeholder="feat/vs-step4" onChange={(e) => setBranch(e.target.value)} />
              </Field>
            )}
          </div>
        </div>
        <div className="na-col">
          <Field label="BRIEF">
            <textarea
              value={prompt}
              rows={14}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>
          <button
            className="btn ghost small"
            onClick={clearPrompt}
          >
            Reset to {profileName} template
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function defaultBuddyBrief(squadName: string, topic: string): string {
  const cleanTopic = topic.trim() || "New Feature";
  return [
    `Brainstorm Buddy for ${squadName} · ${cleanTopic}.`,
    "Explore the design with the user, check `vs log --since-me` for shared squad decisions, and hand off the approved plan to a lane lead.",
  ].join("\n");
}

export function AddBuddyModal({
  view,
  onClose,
  onCreated,
  onOpenExisting,
}: {
  view: TeamView;
  onClose: () => void;
  onCreated: (id: string) => void;
  onOpenExisting?: (id: string) => void;
}) {
  const { agents, workspaces } = usePaseo();
  const { profiles } = useProfiles();
  const team = view.team;
  const brainstormProfiles = useMemo(
    () => profiles.filter((p) => p.role === "brainstorm"),
    [profiles],
  );
  const [profileName, setProfileName] = useState("Brainstorm - Claude");
  const profile =
    findProfile(profileName, profiles) ??
    brainstormProfiles[0] ??
    findProfile("brainstorm", profiles) ??
    profiles[0]!;
  const [topic, setTopic] = useState("");
  const [customBrief, setCustomBrief] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [logs, setLogs] = useState<BuddyOverlapLogEntry[]>([]);
  const [confirmOverlap, setConfirmOverlap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const dirs = useMemo(() => {
    const set = new Set<string>();
    for (const m of view.members) if (m.agent.status !== "closed" && m.agent.cwd) set.add(m.agent.cwd);
    const needles = team.paths.map((p) => p.toLowerCase().replace(/-$/, ""));
    for (const w of workspaces.values()) {
      const d =
        (w as { workspaceDirectory?: string; directory?: string }).workspaceDirectory ??
        (w as { directory?: string }).directory;
      if (d && needles.some((n) => d.toLowerCase().includes(n))) set.add(d);
    }
    if (set.size === 0 && team.paths[0]) set.add(team.paths[0]);
    return [...set];
  }, [view, workspaces, team]);

  useEffect(() => {
    if (!cwd && dirs[0]) setCwd(dirs[0]);
  }, [dirs, cwd]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/__vibesquad/log?team=${encodeURIComponent(team.id)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setLogs(data as BuddyOverlapLogEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  const { id: laneId, name: laneName } = useMemo(
    () => slugifyFeatureLane(team.id, topic),
    [team.id, topic],
  );

  const allMembers = useMemo(() => resolve(agents), [agents]);

  const overlap = useMemo(
    () => checkBuddyOverlap(topic, view, logs, allMembers),
    [topic, view, logs, allMembers],
  );

  useEffect(() => {
    setConfirmOverlap(false);
  }, [overlap?.laneId, topic]);

  const existingLane = team.lanes.some(
    (l) => l.id.toLowerCase() === laneId.toLowerCase() || Boolean(l.aliases?.some((a) => a.toLowerCase() === laneId.toLowerCase())),
  );
  const title = titleFor("brainstorm", laneName, { topic: existingLane ? topic.trim() : "" });
  const brief = customBrief ?? defaultBuddyBrief(team.name, topic);
  const labels: Record<string, string> = {
    team: team.id,
    lane: laneId,
    lead: laneId,
    role: "brainstorm",
    profile: profile.name,
    ...(topic.trim() ? { topic: topic.trim() } : {}),
  };

  const defaults = defaultSpawnConfigFor(profile.provider);
  const modeId = profile.modeId ?? defaults.modeId;

  const submit = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const hasLane = (t: TeamDef) =>
        t.lanes.some(
          (l) =>
            l.id.toLowerCase() === laneId.toLowerCase() ||
            Boolean(l.aliases?.some((a) => a.toLowerCase() === laneId.toLowerCase())),
        );
      const targetTeam = getTeams().find((t) => t.id === team.id);
      if (targetTeam && !hasLane(targetTeam)) {
        await saveTeams((cur) =>
          cur.map((t) => (t.id === team.id && !hasLane(t) ? { ...t, lanes: [...t.lanes, { id: laneId, name: laneName }] } : t)),
        );
      }

      const r = await spawnTeamAgent({
        provider: profile.provider,
        model: profile.model,
        modeId,
        thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues,
        notes: profile.notes,
        approvalPolicy: defaults.approvalPolicy,
        sandbox: defaults.sandbox,
        shareMcp: defaults.shareMcp,
        title,
        labels,
        prompt: brief,
        cwd,
      });
      onCreated(r.id);
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy &&
    Boolean(topic.trim()) &&
    Boolean(cwd) &&
    title.length <= TITLE_LIMIT &&
    (!overlap || confirmOverlap);

  return (
    <Modal
      title={`+ TEAM · ${team.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          {err && <span className="stat-alert small">{err}</span>}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn ok"
            data-testid="add-buddy-submit"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {busy ? "Starting Brainstorm…" : overlap ? "Start Separate Team Anyway" : "+ Start Team"}
          </button>
        </>
      }
    >
      <div className="na-grid">
        <div className="na-col">
          <Field label="FEATURE / TOPIC">
            <input
              data-testid="add-buddy-topic"
              value={topic}
              placeholder="e.g. Mobile Nav, Combat Loop, Auth Flow"
              autoFocus
              onChange={(e) => setTopic(e.target.value)}
            />
          </Field>
          {overlap && (
            <div className="dup-warning" data-testid="buddy-overlap-warning" role="alert">
              <b>⚠ OVERLAP DETECTED · {overlap.laneName.toUpperCase()}</b>
              <div className="small">{overlap.reason}</div>
              <div className="row2" style={{ marginTop: 6, alignItems: "center" }}>
                {overlap.buddy && (
                  <button
                    type="button"
                    className="btn ok small"
                    data-testid="open-existing-buddy-btn"
                    onClick={() => {
                      const existingId = overlap.buddy!.agent.id;
                      if (onOpenExisting) onOpenExisting(existingId);
                      else onCreated(existingId);
                      onClose();
                    }}
                  >
                    Open existing Team ({overlap.laneName})
                  </button>
                )}
                <label className="check small">
                  <input
                    type="checkbox"
                    data-testid="confirm-buddy-overlap"
                    checked={confirmOverlap}
                    onChange={(e) => setConfirmOverlap(e.target.checked)}
                  />{" "}
                  Separate scope — start a new Team anyway
                </label>
              </div>
            </div>
          )}
          <div className="row2">
            <Field label="BRAINSTORM PROFILE">
              <select value={profile.name} onChange={(e) => setProfileName(e.target.value)}>
                {(brainstormProfiles.length ? brainstormProfiles : profiles).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="WORKSPACE">
              <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
                {dirs.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="preview">
            <div className="field-label">TEAM</div>
            <div className="preview-title" data-testid="add-buddy-lane-preview">
              {laneName} <span className="muted small">({laneId})</span>
            </div>
            <div className="field-label">BRAINSTORM TITLE PREVIEW</div>
            <div className="preview-title">{title}</div>
            <div className="field-label">LABELS</div>
            <div className="pills">
              {Object.entries(labels).map(([k, v]) => (
                <span key={k} className="label-pill">
                  {k}={v}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="na-col">
          <Field label="CONTEXT BRIEF (2–3 LINES)">
            <textarea
              data-testid="add-buddy-brief"
              value={brief}
              rows={8}
              onChange={(e) => setCustomBrief(e.target.value)}
            />
          </Field>
          {customBrief !== null && (
            <button className="btn ghost small" onClick={() => setCustomBrief(null)}>
              Reset to default Brainstorm brief
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
