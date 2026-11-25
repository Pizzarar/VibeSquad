import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultSpawnConfigFor } from "./antigravity";
import { spawnTeamAgent, usePaseo } from "./paseo";
import { branchHint } from "./workspaceLogic";
import {
  checkBuddyOverlap,
  getTeams,
  ordOf,
  resolve,
  saveTeams,
  shownLanesOf,
  slugifyFeatureLane,
  titleFor,
  type BuddyOverlapLogEntry,
  type TeamDef,
  type TeamView,
} from "./teams";
import { freezeLaneCodes } from "./identity";
import { useDraft } from "./drafts";
import { rememberSent, useImageDraft } from "./imageDrafts";
import { spawnTeamAgentWithImages } from "./paseoSpawn";
import { defaultNewAgentProfile, getPref, reapplyDefaultProfile } from "./prefs";
import { DEMO_LADDER, DEMO_ROLES, fetchRoles, findProfile, getProfiles, profileRoleName, rolePickRows, shortModel, useProfiles, type Profile, type Role } from "./profiles";
import { STAKES_CHOICES, buildRoleSpawn, allCappedNote, landingPick, overrideGroups, parseOverrideValue, providerName, type Override } from "./roleSpawn";

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

/** Naming Standard v2 (docs/NAMING.md): labels are the source of truth, the title is generated. */
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
    if (i.ord) labels.ord = i.ord; // the lead's ord, so the title is `<Code><ord> · <job>`
    if (i.task) labels.task = i.task;
  }
  const title = titleFor(i.role === "lead" || i.role === "brainstorm" ? i.role : "worker", LANE_, { ord: i.ord, topic: i.topic, job: i.job, laneId: i.laneId });
  return { title, labels };
}

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; className?: string }) {
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
      <div className={`modal ${props.wide ? "wide" : ""} ${props.className ?? ""}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={props.title}>
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

/** Which model a role row will run: the ladder's pick for these stakes (after capped failover), or the override.
 *  `warn` = every provider is capped (Spawn stays enabled; the note says what happens). */
function roleBadges(roleKey: string, roleDef: { name: string; tier: string; providers: string[] }, ladder: Parameters<typeof landingPick>[1], stakes: string, override: Override | null, capped: readonly string[]): { badges: [string, string][]; note: string } {
  const l = landingPick(roleDef, ladder, stakes, { capped, override, roleKey });
  return { badges: [["provider/model", `${providerName(l.provider)}/${l.model}`], ["via", l.via], ["stakes", stakes]], note: l.allCapped ? allCappedNote(l.provider) : "" };
}

/** Optional model override, grouped by the role's providers: "From ladder (stakes)" | "<provider> · ladder model" | "<provider> · <model>". */
function ModelOverrideSelect({ role, ladder, value, onChange }: { role: { name: string; tier: string; providers: string[] }; ladder: Parameters<typeof overrideGroups>[1]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="MODEL OVERRIDE (optional)">
      <select value={value} data-testid="model-override" onChange={(e) => onChange(e.target.value)}>
        <option value="">From ladder (stakes)</option>
        {overrideGroups(role, ladder).map((g) => (
          <optgroup key={g.provider} label={providerName(g.provider)}>
            <option value={g.provider}>{providerName(g.provider)} · ladder model</option>
            {g.models.map((m) => (
              <option key={m} value={`${g.provider}|${m}`}>
                {shortModel(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

export function NewAgentModal({ view, onClose, onCreated }: { view: TeamView; onClose: () => void; onCreated: (id: string) => void }) {
  const { agents, workspaces } = usePaseo();
  const { profiles, installedProviders, roles: rolesState, ladder: ladderState, capped: cappedState } = useProfiles();
  const capped = cappedState ?? [];
  useEffect(() => void fetchRoles(), []); // R2: fresh caps each time the modal opens
  const roles = rolesState ?? DEMO_ROLES;
  const ladder = ladderState ?? DEMO_LADDER;
  const team = view.team;
  // Settings › New Agent defaults prefill profile and folder (empty = the built-in choice).
  const resolveProfile = (name: string) => findProfile(name, profiles)?.name;
  const [profileName, setProfileName] = useState(() => defaultNewAgentProfile(getPref("newAgent.profile"), resolveProfile));
  const profile = findProfile(profileName, profiles) ?? profiles[0]!;
  // R1: a role row sends the ROLE as the profile; stakes x tier ladder picks the model unless the spawner overrides it.
  const [stakes, setStakes] = useState<string>("normal");
  const [ovValue, setOvValue] = useState(""); // "" = from ladder, "<provider>" or "<provider>|<model>"
  const roleName = profileRoleName(profile.name) ?? profile.name;
  const pickRow = rolePickRows(profiles, profile.name).find((r) => r.value === profile.name);
  const roleDef = pickRow ? roles[pickRow.roleKey] : undefined;
  // A saved legacy pick (or an unknown role) keeps today's pinned-profile spawn until changed.
  const viaRole = !!pickRow && !pickRow.legacy && !!roleDef && !!pickRow.roleKey;
  const override = viaRole ? parseOverrideValue(ovValue) : null;
  const roleSpawn = viaRole ? buildRoleSpawn({ roleKey: pickRow!.roleKey, role: roleDef!, ladder, stakes, override }) : null;
  const savedDefault = getPref("newAgent.profile").trim();
  const savedMissing = !!savedDefault && !findProfile(savedDefault, profiles);
  const [role, setRole] = useState<Role>(profile.role);
  // The modal can open before /__vibesquad/profiles loads: re-apply a custom default once they arrive,
  // unless the user already chose a profile or role.
  const userPickedProfile = useRef(false);
  useEffect(() => {
    const next = reapplyDefaultProfile(profileName, getPref("newAgent.profile"), resolveProfile, userPickedProfile.current);
    const p = next ? findProfile(next, profiles) : undefined;
    if (!p) return;
    setProfileName(p.name);
    setRole(p.role);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the profile list changes
  }, [profiles]);
  const [laneId, setLaneId] = useState(shownLanesOf(team)[0]?.id ?? "");
  const [ord, setOrd] = useState("1");
  const [topic, setTopic, clearTopic] = useDraft(`new-agent:${team.id}:topic`);
  const [task, setTask] = useState("");
  const [job, setJob] = useState("");
  const [promptDraft, setPrompt, clearPrompt] = useDraft(`new-agent:${team.id}:${profileName}:prompt`);
  const prompt = promptDraft || profile.brief;
  const imgs = useImageDraft(`new-agent:${team.id}:${profileName}:images`);
  const [dragOver, setDragOver] = useState(false);
  const imgInput = useRef<HTMLInputElement>(null);
  const stageImages = (fl: File[]) => imgs.add(fl.filter((f) => f.type.startsWith("image/")));
  const [cwd, setCwd] = useState(() => getPref("newAgent.folder").trim());
  const [newWt, setNewWt] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Directory suggestions
  const [cwdSugs, setCwdSugs] = useState<string[]>([]);

  // Add project drawer
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [addProjectPath, setAddProjectPath] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [addProjectErr, setAddProjectErr] = useState("");

  // Worktree picker
  type WorktreeEntry = { worktreePath: string; branchName?: string | null };
  const [existingWts, setExistingWts] = useState<WorktreeEntry[]>([]);
  const [wtMode, setWtMode] = useState<"none" | "existing" | "new">("none");
  const [selectedWt, setSelectedWt] = useState("");

  // No VS git route to validate or suggest branches yet (P4 blocker), so the hint is the static one.
  const branchCheck = null;
  const branchSugs: string[] = [];
  const hint = branchHint(branch, branchCheck);

  const onCwdChange = (val: string) => {
    setCwd(val);
  };

  const addLocalProject = async () => {
    const path = addProjectPath.trim();
    if (!path) return;
    setAddingProject(true);
    setAddProjectErr("");
    try {
      await saveTeams((cur) =>
        cur.map((t) =>
          t.id === team.id && !t.paths.includes(path) ? { ...t, paths: [...t.paths, path] } : t,
        ),
      );
      setCwd(path);
      setAddProjectPath("");
      setAddProjectOpen(false);
    } catch (e) {
      setAddProjectErr(String(e));
    } finally {
      setAddingProject(false);
    }
  };

  const dirs = useMemo(() => {
    const set = new Set<string>();
    const isRuntime = (d: string) => /vibesquad[\\/]runtime/i.test(d);
    for (const p of team.paths) if (/^([a-z]:|[\\/])/i.test(p)) set.add(p);
    for (const m of view.members) if (m.agent.status !== "closed" && !isRuntime(m.agent.cwd)) set.add(m.agent.cwd);
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
    userPickedProfile.current = true;
    const p = findProfile(name, profiles) ?? profiles[0]!;
    setOvValue("");
    setProfileName(p.name);
    setRole(p.role);
  };

  const lane = team.lanes.find((l) => l.id === laneId);
  // A worker is titled with its lane's live lead ord (the ORD field is lead-only).
  const liveLead = view.lanes.find((l) => l.lane.id === laneId)?.lead;
  const effectiveOrd = role === "lead" ? ord : liveLead ? String(ordOf(liveLead.agent)) : "";
  const { title, labels: baseLabels } = buildName({
    team: team.id,
    laneId,
    laneName: lane?.name ?? laneId,
    role,
    profile: roleSpawn ? roleSpawn.profile : profile.name,
    ord: effectiveOrd,
    topic,
    task,
    job,
  });
  const spawnProvider = roleSpawn ? roleSpawn.provider : profile.provider;
  // What gets written: the preview shows it all (stakes, route override), same as Add Buddy.
  const labels = roleSpawn ? { ...baseLabels, ...roleSpawn.labels } : baseLabels;
  const defaults = defaultSpawnConfigFor(spawnProvider);
  const modeId = roleSpawn ? undefined : (profile.modeId ?? defaults.modeId);
  const isProviderInstalled = installedProviders.includes(spawnProvider);
  const landing = roleSpawn && roleDef ? roleBadges(roleSpawn.profile, roleDef, ladder, stakes, override, capped) : null;
  const badges: [string, string][] = landing ? landing.badges : [["provider/model", `${profile.provider}/${profile.model}`]];
  if (modeId) badges.push(["modeId", modeId]);
  if (!roleSpawn && profile.thinkingOptionId) badges.push(["thinkingOptionId", profile.thinkingOptionId]);
  if (roleSpawn) {
    badges.push(["shareMcp", String(defaults.shareMcp)]);
  } else if (profile.featureValues && Object.keys(profile.featureValues).length > 0) {
    for (const [k, v] of Object.entries(profile.featureValues)) {
      badges.push([k, String(v)]);
    }
  } else {
    if (defaults.approvalPolicy) badges.push(["approvalPolicy", defaults.approvalPolicy]);
    if (defaults.sandbox) badges.push(["sandbox", defaults.sandbox]);
    badges.push(["shareMcp", String(defaults.shareMcp)]);
  }

  const finished = useRef(false);
  // Snapshot at submit: finish() can run from the live-agents subscription before create resolves.
  const sentFirst = useRef<{ text: string; images: Array<{ blob: Blob }> }>({ text: "", images: [] });
  const finish = (id: string) => {
    if (finished.current) return;
    finished.current = true;
    if (sentFirst.current.images.length) rememberSent(id, sentFirst.current.text, sentFirst.current.images);
    clearTopic();
    clearPrompt();
    imgs.clear();
    onCreated(id);
    onClose();
  };
  // Paseo create can take >60s or error after the agent exists: close as soon as it shows in the live list.
  const spawnedTitle = useRef<string | null>(null);
  const existingIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!busy || !spawnedTitle.current) return;
    for (const a of agents.values()) if (!existingIds.current.has(a.id) && a.title === spawnedTitle.current) return finish(a.id);
  }, [agents, busy]);

  const submit = async () => {
    setBusy(true);
    setErr("");
    existingIds.current = new Set(agents.keys());
    sentFirst.current = { text: prompt, images: imgs.images.map((i) => ({ blob: i.blob })) };
    spawnedTitle.current = title;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([spawnTeamAgentWithImages({
        provider: spawnProvider,
        ...(roleSpawn
          ? roleSpawn.model ? { model: roleSpawn.model } : {}
          : { model: profile.model, modeId, thinkingOptionId: profile.thinkingOptionId, featureValues: profile.featureValues, notes: profile.notes }),
        approvalPolicy: defaults.approvalPolicy,
        sandbox: defaults.sandbox,
        shareMcp: defaults.shareMcp,
        title,
        labels,
        prompt,
        cwd,
        worktree: newWt && branch ? { branch } : undefined,
      }, sentFirst.current.images), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("Spawn timed out after 90s. The agent may still have been created: check the roster before retrying.")), 90000); })]);
      finish(r.id);
    } catch (e) {
      if (!finished.current) {
        const msg = String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
        setErr(/did not start|timeout|timed out/i.test(msg) && !/roster/.test(msg) ? `${msg} The agent may still have been created: check the roster before retrying.` : msg);
      }
    } finally {
      clearTimeout(timer);
      spawnedTitle.current = null;
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
          {!busy && !canSubmit && role === "worker" && (!task || !job) && (
            <span className="small muted" data-testid="spawn-needs">Needs: {[!task && "Task id", !job && "Job"].filter(Boolean).join(", ")}</span>
          )}
          <button className="btn ok" disabled={!canSubmit} onClick={submit}>
            {busy ? "Spawning…" : "Spawn agent"}
          </button>
        </>
      }
    >
      <div className="na-grid">
        <div className="na-col">
          <Field label="ROLE">
            <select value={profile.name} onChange={(e) => pickProfile(e.target.value)}>
              {rolePickRows(profiles, profile.name).map((r) => {
                const p = findProfile(r.value, profiles);
                const inst = !p || installedProviders.includes(p.provider);
                return (
                  <option key={r.value} value={r.value} title={r.value} style={inst ? undefined : { opacity: 0.55 }}>
                    {inst ? r.label : `${r.label} (install ${p!.provider})`}
                  </option>
                );
              })}
            </select>
          </Field>
          {savedMissing && !userPickedProfile.current && (
            <div className="stat-alert small" data-testid="saved-default-missing">
              Saved default &quot;{savedDefault}&quot; is missing; using {roleName}.
            </div>
          )}
          {viaRole && roleDef ? (
            <>
              <Field label="STAKES">
                <select value={stakes} data-testid="stakes-select" onChange={(e) => setStakes(e.target.value)}>
                  {STAKES_CHOICES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </Field>
              <ModelOverrideSelect role={roleDef} ladder={ladder} value={ovValue} onChange={setOvValue} />
            </>
          ) : (
            <div className="muted small" data-testid="legacy-pick-note">
              Saved legacy pick: spawns with its pinned model until you choose a role.
            </div>
          )}
          {!isProviderInstalled && (
            <div className="stat-alert small" data-testid="missing-provider-badge">
              Provider not installed: install {spawnProvider}
            </div>
          )}
          <div className="spawn-defaults" title="Applied at spawn (A1/A6)">
            {badges.map(([k, v]) => {
              // R2 (UX m3): the landing badge reads as a warning when every provider is capped.
              const warn = k === "via" && Boolean(landing?.note);
              return (
                <span key={k} className={warn ? "def-badge def-badge-warn" : "def-badge"}>
                  <b>{k}</b> {v}
                </span>
              );
            })}
          </div>
          {landing?.note && (
            <div className="stat-alert small" data-testid="all-capped-note">
              {landing.note}
            </div>
          )}
          <div className="row2">
            <Field label="SEAT">
              <select
                value={role}
                onChange={(e) => {
                  userPickedProfile.current = true;
                  setRole(e.target.value as Role);
                }}
              >
                <option value="lead">lead</option>
                <option value="brainstorm">brainstorm</option>
                <option value="worker">worker</option>
              </select>
            </Field>
            <Field label="TEAM">
              <select value={laneId} onChange={(e) => setLaneId(e.target.value)}>
                {shownLanesOf(team).length === 0 && <option value="">(no teams)</option>}
                {shownLanesOf(team).map((l) => (
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
              <Field label="TASK (required)">
                <input value={task} placeholder="task-id" onChange={(e) => setTask(e.target.value)} />
              </Field>
              <Field label="JOB (required)">
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
                  {k}={k === "profile" ? (profileRoleName(v) ?? v) : v}
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
            {addProjectOpen ? "▲ Close" : "+ Add folder"}
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
                {hint && (
                  <div data-testid="branch-hint" className="small" style={{ marginTop: 4, color: hint.tone === "bad" ? "var(--red, #ff5c7a)" : hint.tone === "warn" ? "var(--amber, #ffb84d)" : hint.tone === "ok" ? "var(--cyan, #4de1ff)" : undefined }}>
                    {hint.text}
                  </div>
                )}
                {branchSugs.length > 0 && (
                  <div className="small muted" style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
                    existing:
                    {branchSugs.map((b) => (
                      <span key={b} className="chip" style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
                    ))}
                  </div>
                )}
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
              className={dragOver ? "drag-over" : ""}
              onPaste={(e) => {
                const fl = Array.from(e.clipboardData?.items ?? [])
                  .filter((i) => i.kind === "file")
                  .map((i) => i.getAsFile())
                  .filter((f): f is File => !!f && f.type.startsWith("image/"));
                if (fl.length) {
                  e.preventDefault();
                  stageImages(fl);
                }
              }}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
                  e.preventDefault();
                  setDragOver(true);
                }
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                stageImages(Array.from(e.dataTransfer?.files ?? []));
              }}
            />
          </Field>
          <input
            ref={imgInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="new-agent-image-input"
            onChange={(e) => {
              stageImages(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {imgs.images.length > 0 && (
            <div className="composer-images composer-thumbs" data-testid="new-agent-thumbs">
              {imgs.images.map((im) => (
                <div key={im.id} className="composer-thumb" title={im.name}>
                  <img src={im.url} alt={im.name} />
                  <span className="thumb-name">{im.name}</span>
                  <button className="thumb-x composer-thumb-remove" aria-label={`Remove ${im.name}`} onClick={() => imgs.remove(im.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="btn ghost small" onClick={() => imgInput.current?.click()}>
            📎 Attach images
          </button>
          <button
            className="btn ghost small"
            onClick={clearPrompt}
          >
            Reset to {roleName} template
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
  const { profiles, installedProviders, roles: rolesState, ladder: ladderState, capped: cappedState } = useProfiles();
  const capped = cappedState ?? [];
  useEffect(() => void fetchRoles(), []);
  const roles = rolesState ?? DEMO_ROLES;
  const ladder = ladderState ?? DEMO_LADDER;
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
  const [stakes, setStakes] = useState<string>("normal");
  const [ovValue, setOvValue] = useState("");
  const pickRow = rolePickRows(profiles, profile.name, (p) => p.role === "brainstorm").find((r) => r.value === profile.name);
  const roleDef = pickRow ? roles[pickRow.roleKey] : undefined;
  const viaRole = !!pickRow && !pickRow.legacy && !!roleDef;
  const roleSpawn = viaRole ? buildRoleSpawn({ roleKey: pickRow!.roleKey, role: roleDef!, ladder, stakes, override: parseOverrideValue(ovValue) }) : null;
  const [topic, setTopic] = useState("");
  const [customBrief, setCustomBrief] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [logs, setLogs] = useState<BuddyOverlapLogEntry[]>([]);
  const [confirmOverlap, setConfirmOverlap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const dirs = useMemo(() => {
    const set = new Set<string>();
    const isRuntime = (d: string) => /vibesquad[\\/]runtime/i.test(d);
    for (const p of team.paths) if (/^([a-z]:|[\\/])/i.test(p)) set.add(p);
    for (const m of view.members) if (m.agent.status !== "closed" && m.agent.cwd && !isRuntime(m.agent.cwd)) set.add(m.agent.cwd);
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
  const title = titleFor("brainstorm", laneName, { topic: existingLane ? topic.trim() : "", laneId });
  const brief = customBrief ?? defaultBuddyBrief(team.name, topic);
  const labels: Record<string, string> = {
    team: team.id,
    lane: laneId,
    lead: laneId,
    role: "brainstorm",
    profile: roleSpawn ? roleSpawn.profile : profile.name,
    ...(topic.trim() ? { topic: topic.trim() } : {}),
    ...(roleSpawn ? roleSpawn.labels : {}),
  };

  const spawnProvider = roleSpawn ? roleSpawn.provider : profile.provider;
  const defaults = defaultSpawnConfigFor(spawnProvider);
  const modeId = roleSpawn ? undefined : (profile.modeId ?? defaults.modeId);
  const buddyLanding = roleSpawn && roleDef ? roleBadges(roleSpawn.profile, roleDef, ladder, stakes, parseOverrideValue(ovValue), capped) : null;
  const buddyBadges: [string, string][] = buddyLanding ? buddyLanding.badges : [["provider/model", `${profile.provider}/${profile.model}`]];

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
          cur.map((t) => (t.id === team.id && !hasLane(t) ? { ...t, lanes: freezeLaneCodes([...freezeLaneCodes(t.lanes), { id: laneId, name: laneName }]) } : t)),
        );
      }

      const r = await spawnTeamAgent({
        provider: spawnProvider,
        ...(roleSpawn
          ? roleSpawn.model ? { model: roleSpawn.model } : {}
          : { model: profile.model, modeId, thinkingOptionId: profile.thinkingOptionId, featureValues: profile.featureValues, notes: profile.notes }),
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
            <Field label="BRAINSTORM ROLE">
              <select value={profile.name} onChange={(e) => { setOvValue(""); setProfileName(e.target.value); }}>
                {rolePickRows(profiles, profile.name, (p) => p.role === "brainstorm").map((r) => (
                  <option key={r.value} value={r.value} title={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            {viaRole && roleDef && (
              <Field label="STAKES">
                <select value={stakes} data-testid="stakes-select" onChange={(e) => setStakes(e.target.value)}>
                  {STAKES_CHOICES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <div className="row2">
            {viaRole && roleDef && <ModelOverrideSelect role={roleDef} ladder={ladder} value={ovValue} onChange={setOvValue} />}
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
          <div className="spawn-defaults" title="Which model this Buddy will run" data-testid="add-buddy-badges">
            {buddyBadges.map(([k, v]) => {
              const warn = k === "via" && Boolean(buddyLanding?.note);
              return (
                <span key={k} className={warn ? "def-badge def-badge-warn" : "def-badge"}>
                  <b>{k}</b> {v}
                </span>
              );
            })}
          </div>
          {buddyLanding?.note && (
            <div className="stat-alert small" data-testid="all-capped-note">
              {buddyLanding.note}
            </div>
          )}
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
                  {k}={k === "profile" ? (profileRoleName(v) ?? v) : v}
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
