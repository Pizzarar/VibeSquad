import { useEffect, useState } from "react";
import { getUserName, saveLanEnabled, saveUserName, useExposedIpsStore, useLanEnabled } from "./userName";
import {
  AGENT_TYPE_NAME,
  BRAINSTORM_RESTART_DEFAULT,
  BRAINSTORM_WARN_DEFAULT,
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  getDiskTeams,
  getTeams,
  resetTeamsToDisk,
  saveTeams,
  type AgentType,
  type TeamDef,
} from "./teams";
import { Avatar } from "./pixel";
import { useDraft } from "./drafts";
import { Field, Modal } from "./TeamActions";
import {
  detectNoteWarnings,
  dismissSetupPrompt,
  fetchProfiles,
  importFromPaseo,
  saveProfile,
  seedDefaultPack,
  useProfiles,
  type Profile,
} from "./profiles";
import {
  UI_SCALE_PRESETS,
  resetUiScale,
  setUiScale,
  useUiScale,
} from "./uiScale";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const ARCHETYPES: { type: AgentType; desc: string; sampleProv: string }[] = [
  { type: "lead", desc: "Shades, pompadour & power blazer", sampleProv: "gemini" },
  { type: "retired-lead", desc: "Shades up & a warm mug", sampleProv: "claude" },
  { type: "brainstorm", desc: "Studio cans & a lightbulb", sampleProv: "claude" },
  { type: "implement", desc: "Cap, goggles & wrench", sampleProv: "claude" },
  { type: "mechanical", desc: "Hard hat & hi-vis vest", sampleProv: "codex" },
  { type: "review", desc: "Fedora, trench & loupe", sampleProv: "gemini" },
  { type: "audit", desc: "Hood up & recon visor", sampleProv: "deepseek" },
  { type: "spec", desc: "Big frames & blueprint", sampleProv: "gemini" },
  { type: "art", desc: "Beret, brush & paint", sampleProv: "gemini" },
  { type: "unknown", desc: "Sweatband & synth hoodie", sampleProv: "codex" },
];

export function ProfileImportModal({ onClose }: { onClose: () => void }) {
  const { paseoProfiles, profiles, diff, warningsByProfile, installedProviders, needsSetup } = useProfiles();
  const candidates = paseoProfiles.length > 0 ? paseoProfiles : profiles;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((p) => p.name)));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void fetchProfiles();
  }, []);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onImportSelected = async () => {
    setBusy(true);
    setStatus("");
    try {
      await importFromPaseo([...selected], true);
      onClose();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSeedDefault = async () => {
    setBusy(true);
    setStatus("");
    try {
      await seedDefaultPack();
      onClose();
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  const diffByName = new Map(diff.map((d) => [d.name, d]));

  return (
    <Modal
      title={needsSetup ? "SETUP · IMPORT PASEO PROFILES" : "SYNC / RE-IMPORT PROFILES FROM PASEO"}
      onClose={() => {
        dismissSetupPrompt();
        onClose();
      }}
      wide
      footer={
        <>
          {status && <span className="stat-alert small">{status}</span>}
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              dismissSetupPrompt();
              onClose();
            }}
          >
            Later
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-testid="profiles-seed-default-btn"
            onClick={onSeedDefault}
          >
            Seed Default Pack (19 project-neutral)
          </button>
          <button
            type="button"
            className="btn ok"
            disabled={busy || selected.size === 0}
            data-testid="profiles-import-selected-btn"
            onClick={onImportSelected}
          >
            {busy ? "Importing…" : `Import ${selected.size} profile(s)`}
          </button>
        </>
      }
    >
      <div className="muted small" style={{ marginBottom: 10 }}>
        VibeSquad stores profiles in <code>~/.vibesquad/profiles.json</code>. Check the Paseo profiles to import, or seed the 19-profile project-neutral default pack.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button type="button" className="btn ghost small" onClick={() => setSelected(new Set(candidates.map((p) => p.name)))}>
          Select all ({candidates.length})
        </button>
        <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>
          Select none
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
        {candidates.map((p) => {
          const d = diffByName.get(p.name);
          const warns = warningsByProfile[p.name] ?? detectNoteWarnings(p.notes);
          const inst = installedProviders.includes(p.provider);
          return (
            <label
              key={p.name}
              className="ts-team"
              style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", opacity: inst ? 1 : 0.65 }}
              data-testid={`import-profile-row-${p.name}`}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input
                  type="checkbox"
                  checked={selected.has(p.name)}
                  onChange={() => toggle(p.name)}
                />
                <b>{p.name}</b>
                <span className="chip">{p.role}</span>
                <span className="def-badge">
                  <b>provider/model</b> {p.provider}/{p.model}
                </span>
                {p.modeId && (
                  <span className="def-badge">
                    <b>modeId</b> {p.modeId}
                  </span>
                )}
                {p.thinkingOptionId && (
                  <span className="def-badge">
                    <b>thinking</b> {p.thinkingOptionId}
                  </span>
                )}
                {!inst && (
                  <span className="pill diag warn" data-testid={`install-provider-${p.name}`}>
                    install {p.provider}
                  </span>
                )}
                {d && d.status !== "same" && (
                  <span className="pill diag hot">
                    {d.status} ({d.changedFields.join(", ")})
                  </span>
                )}
                {d && d.status === "same" && <span className="muted small">in sync</span>}
              </div>
              {warns.map((w, idx) => (
                <div key={idx} className="stat-alert small" data-testid={`profile-warning-${p.name}`}>
                  ⚠ {w}
                </div>
              ))}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

export function TeamSettingsModal({ onClose }: { onClose: () => void }) {
  const [teams, setTeams] = useState<TeamDef[]>(() => JSON.parse(JSON.stringify(getTeams())));
  const [msg, setMsg] = useDraft("settings:msg");
  const { profiles, installedProviders, diff } = useProfiles();
  const [selectedProfileName, setSelectedProfileName] = useState<string>(() => profiles[0]?.name ?? "Lead - Claude");
  const activeProfile = profiles.find((p) => p.name === selectedProfileName) ?? profiles[0];
  const [draftProfile, setDraftProfile] = useState<Profile | null>(() => (activeProfile ? { ...activeProfile } : null));
  const [featuresJson, setFeaturesJson] = useState<string>(() =>
    activeProfile?.featureValues ? JSON.stringify(activeProfile.featureValues) : "{}",
  );
  const [showImportModal, setShowImportModal] = useState(false);

  const selectProfileForEdit = (name: string) => {
    setSelectedProfileName(name);
    const found = profiles.find((p) => p.name === name);
    if (found) {
      setDraftProfile({ ...found });
      setFeaturesJson(found.featureValues ? JSON.stringify(found.featureValues) : "{}");
    }
  };

  const onSaveProfile = async () => {
    if (!draftProfile) return;
    try {
      const parsedFv = featuresJson.trim() ? JSON.parse(featuresJson) : undefined;
      const cleanFv = parsedFv && Object.keys(parsedFv).length > 0 ? parsedFv : undefined;
      await saveProfile({
        ...draftProfile,
        featureValues: cleanFv,
      });
      setMsg(`Saved profile "${draftProfile.name}" to ~/.vibesquad/profiles.json`);
    } catch (e) {
      setMsg(`Profile save error: ${e}`);
    }
  };

  const [nameDraft, setNameDraft] = useState(() => (getUserName() === "you" ? "" : getUserName()));
  const lanEnabled = useLanEnabled();
  const exposedIps = useExposedIpsStore();
  const uiScale = useUiScale();
  const uiScalePct = Math.round(uiScale * 100);
  const patch = (i: number, p: Partial<TeamDef>) => setTeams((ts) => ts.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const patchLane = (i: number, k: number, p: Partial<TeamDef["lanes"][number]>) =>
    patch(i, { lanes: teams[i].lanes.map((x, j) => (j === k ? { ...x, ...p } : x)) });

  const save = async () => {
    const clean = teams.filter((t) => t.id.trim()).map((t) => ({
      ...t,
      id: slug(t.id),
      brainstormWarnTokens: Number(t.brainstormWarnTokens) || BRAINSTORM_WARN_DEFAULT,
      brainstormRestartTokens: Number(t.brainstormRestartTokens) || BRAINSTORM_RESTART_DEFAULT,
      leadFlagTokens: Number(t.leadFlagTokens) || LEAD_FLAG_DEFAULT,
      leadAutoHandoffTokens: Number(t.leadAutoHandoffTokens) || LEAD_AUTO_HANDOFF_DEFAULT,
      leadHardCapTokens: Number(t.leadHardCapTokens) || LEAD_HARD_CAP_DEFAULT,
    }));
    const r = await saveTeams(clean);
    setMsg(r.disk ? "Saved to browser and teams.json" : "Saved to browser only (no dev server to write teams.json)");
  };

  return (
    <Modal
      title="TEAM SETTINGS"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small">{msg}</span>
          <button
            className="btn ghost"
            onClick={() => {
              resetTeamsToDisk();
              setTeams(getDiskTeams());
              setMsg("Reset to teams.json");
            }}
          >
            Reset to disk
          </button>
          <button
            className="btn ghost"
            onClick={() => navigator.clipboard?.writeText(JSON.stringify({ teams }, null, 2)).then(() => setMsg("JSON copied"))}
          >
            Copy JSON
          </button>
          <button className="btn ok" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <section className="ts-team" data-testid="user-name-section">
        <div className="field-label">YOUR NAME</div>
        <div className="muted small">Shown on NEEDS badges, the owner feed entries and push notifications.</div>
        <input
          data-testid="settings-user-name-input"
          value={nameDraft}
          placeholder="you"
          maxLength={40}
          onChange={(e) => {
            setNameDraft(e.target.value);
            saveUserName(e.target.value);
          }}
        />
      </section>
      <section className="ts-team" data-testid="lan-access-section">
        <div className="ts-scale-head">
          <div>
            <div className="field-label">ALLOW OTHER DEVICES (HOME LAN / MESHNET)</div>
            <div className="muted small">
              Saved in <code>~/.vibesquad/settings.json</code> so restarts keep your choice. Pairing with a 6-digit code is still required.
              {lanEnabled && exposedIps.length > 0 ? ` Active on: ${exposedIps.join(", ")}.` : ""}
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 700 }}>
            <input
              type="checkbox"
              data-testid="settings-lan-enabled-toggle"
              checked={lanEnabled}
              onChange={(e) => {
                void saveLanEnabled(e.target.checked);
              }}
            />
            <span>{lanEnabled ? "Enabled" : "Off (loopback only)"}</span>
          </label>
        </div>
      </section>
      <section className="ts-team ts-scale-section" data-testid="ui-scale-section">
        <div className="ts-scale-head">
          <div>
            <div className="field-label">DISPLAY &amp; 4K UI SCALE</div>
            <div className="muted small">
              Per-device interface scale ({uiScalePct}%). Keyboard:{" "}
              <kbd className="kbd">Ctrl + =</kbd> / <kbd className="kbd">Ctrl + -</kbd> / <kbd className="kbd">Ctrl + 0</kbd>
            </div>
          </div>
          <span className="ui-scale-readout" data-testid="ui-scale-value">
            {uiScalePct}%
          </span>
        </div>
        <div className="ts-scale-controls">
          <input
            type="range"
            min={80}
            max={200}
            step={5}
            value={uiScalePct}
            aria-label="Display & 4K UI Scale"
            data-testid="ui-scale-slider"
            className="ui-scale-slider"
            onChange={(e) => setUiScale(Number(e.target.value) / 100)}
          />
          <div className="ts-scale-presets">
            {UI_SCALE_PRESETS.map((preset) => {
              const pct = Math.round(preset * 100);
              const active = Math.abs(uiScale - preset) < 0.01;
              return (
                <button
                  key={pct}
                  type="button"
                  className={`btn small ${active ? "on" : "ghost"}`}
                  data-testid={`ui-scale-preset-${pct}`}
                  onClick={() => setUiScale(preset)}
                >
                  {pct}%
                </button>
              );
            })}
            <button
              type="button"
              className="btn ghost small"
              data-testid="ui-scale-reset"
              onClick={() => resetUiScale(false)}
            >
              Reset (100%)
            </button>
          </div>
        </div>
      </section>
      <section className="ts-team" data-testid="profiles-settings-section">
        <div className="ts-scale-head" style={{ marginBottom: 8 }}>
          <div>
            <div className="field-label">AGENT PROFILES (~/.vibesquad/profiles.json · {profiles.length} profiles)</div>
            <div className="muted small">
              Every spawn path (New Agent, Handoff, Brainstorm restart, Inbox topic, Digest) reads this store.
              {diff.some((d) => d.status !== "same") ? " Diff detected against Paseo config." : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn small"
              data-testid="open-paseo-sync-btn"
              onClick={() => setShowImportModal(true)}
            >
              Re-import / Sync from Paseo
            </button>
          </div>
        </div>
        {draftProfile && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="row2">
              <Field label="PROFILE">
                <select
                  value={selectedProfileName}
                  data-testid="settings-profile-select"
                  onChange={(e) => selectProfileForEdit(e.target.value)}
                >
                  {profiles.map((p) => {
                    const inst = installedProviders.includes(p.provider);
                    return (
                      <option key={p.name} value={p.name}>
                        {inst ? p.name : `${p.name} (install ${p.provider})`}
                      </option>
                    );
                  })}
                </select>
              </Field>
              <Field label="PROVIDER">
                <input
                  value={draftProfile.provider}
                  data-testid="settings-profile-provider"
                  onChange={(e) => setDraftProfile({ ...draftProfile, provider: e.target.value })}
                />
              </Field>
              <Field label="MODEL">
                <input
                  value={draftProfile.model}
                  data-testid="settings-profile-model"
                  onChange={(e) => setDraftProfile({ ...draftProfile, model: e.target.value })}
                />
              </Field>
            </div>
            <div className="row2">
              <Field label="MODE ID">
                <input
                  value={draftProfile.modeId ?? ""}
                  placeholder="auto / accept-edits / build / plan / default"
                  data-testid="settings-profile-mode"
                  onChange={(e) => setDraftProfile({ ...draftProfile, modeId: e.target.value || undefined })}
                />
              </Field>
              <Field label="THINKING">
                <input
                  value={draftProfile.thinkingOptionId ?? ""}
                  placeholder="low / medium / high / default"
                  data-testid="settings-profile-thinking"
                  onChange={(e) => setDraftProfile({ ...draftProfile, thinkingOptionId: e.target.value || undefined })}
                />
              </Field>
              <Field label="FEATURE VALUES (JSON)">
                <input
                  value={featuresJson}
                  data-testid="settings-profile-features"
                  onChange={(e) => setFeaturesJson(e.target.value)}
                />
              </Field>
            </div>
            <Field label="NOTES (PROJECT-NEUTRAL SYSTEM PROMPT LAYER)">
              <textarea
                rows={4}
                value={draftProfile.notes}
                data-testid="settings-profile-notes"
                onChange={(e) => setDraftProfile({ ...draftProfile, notes: e.target.value })}
              />
            </Field>
            {detectNoteWarnings(draftProfile.notes).map((w, idx) => (
              <div key={idx} className="stat-alert small" data-testid="settings-profile-note-warning">
                ⚠ {w}
              </div>
            ))}
            <div>
              <button type="button" className="btn ok small" data-testid="save-profile-btn" onClick={onSaveProfile}>
                Save profile ({draftProfile.name})
              </button>
            </div>
          </div>
        )}
      </section>
      {showImportModal && <ProfileImportModal onClose={() => setShowImportModal(false)} />}
      {teams.map((t, i) => (
        <section key={i} className="ts-team" style={{ borderLeftColor: t.color }}>
          <div className="row2">
            <Field label="ID">
              <input value={t.id} onChange={(e) => patch(i, { id: e.target.value })} />
            </Field>
            <Field label="NAME">
              <input value={t.name} onChange={(e) => patch(i, { name: e.target.value })} />
            </Field>
            <Field label="COLOR">
              <span className="color-row">
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#777777"} onChange={(e) => patch(i, { color: e.target.value })} />
                <input value={t.color} onChange={(e) => patch(i, { color: e.target.value })} />
              </span>
            </Field>
            <button className="btn ghost small bad-btn" onClick={() => setTeams(teams.filter((_, j) => j !== i))}>
              Delete team
            </button>
          </div>
          <div className="row2">
            <Field label="Brainstorm warn tokens (amber)">
              <input
                type="number"
                aria-label="Brainstorm warn tokens (amber)"
                value={t.brainstormWarnTokens ?? BRAINSTORM_WARN_DEFAULT}
                onChange={(e) => patch(i, { brainstormWarnTokens: Number(e.target.value) || BRAINSTORM_WARN_DEFAULT })}
              />
            </Field>
            <Field label="Brainstorm auto-restart tokens (red)">
              <input
                type="number"
                aria-label="Brainstorm auto-restart tokens (red)"
                value={t.brainstormRestartTokens ?? BRAINSTORM_RESTART_DEFAULT}
                onChange={(e) => patch(i, { brainstormRestartTokens: Number(e.target.value) || BRAINSTORM_RESTART_DEFAULT })}
              />
            </Field>
          </div>
          <div className="row2">
            <Field label="Lead soft flag tokens (amber · wrap up)">
              <input
                type="number"
                aria-label="Lead soft flag tokens (amber · wrap up)"
                data-testid="lead-flag-tokens"
                value={t.leadFlagTokens ?? LEAD_FLAG_DEFAULT}
                onChange={(e) => patch(i, { leadFlagTokens: Number(e.target.value) || LEAD_FLAG_DEFAULT })}
              />
            </Field>
            <Field label="Lead auto-handoff tokens (red · VS auto)">
              <input
                type="number"
                aria-label="Lead auto-handoff tokens (red · VS auto)"
                data-testid="lead-auto-handoff-tokens"
                value={t.leadAutoHandoffTokens ?? LEAD_AUTO_HANDOFF_DEFAULT}
                onChange={(e) => patch(i, { leadAutoHandoffTokens: Number(e.target.value) || LEAD_AUTO_HANDOFF_DEFAULT })}
              />
            </Field>
            <Field label="Lead hard ceiling tokens (forced)">
              <input
                type="number"
                aria-label="Lead hard ceiling tokens (forced)"
                data-testid="lead-hard-cap-tokens"
                value={t.leadHardCapTokens ?? LEAD_HARD_CAP_DEFAULT}
                onChange={(e) => patch(i, { leadHardCapTokens: Number(e.target.value) || LEAD_HARD_CAP_DEFAULT })}
              />
            </Field>
          </div>
          <div className="field-label">LANES (id · name · aliases)</div>
          {t.lanes.map((l, k) => (
            <div key={k} className="row-lane">
              <input value={l.id} placeholder="id" onChange={(e) => patchLane(i, k, { id: e.target.value })} />
              <input value={l.name} placeholder="name" onChange={(e) => patchLane(i, k, { name: e.target.value })} />
              <input
                value={(l.aliases ?? []).join(", ")}
                placeholder="aliases, comma separated"
                onChange={(e) => patchLane(i, k, { aliases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              />
              <button className="btn ghost small" onClick={() => patch(i, { lanes: t.lanes.filter((_, j) => j !== k) })}>
                −
              </button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => patch(i, { lanes: [...t.lanes, { id: "", name: "" }] })}>
            + lane
          </button>
          <div className="field-label">PATH MATCHERS (folder segment; trailing - = prefix)</div>
          {t.paths.map((p, k) => (
            <div key={k} className="row-lane paths">
              <input value={p} onChange={(e) => patch(i, { paths: t.paths.map((x, j) => (j === k ? e.target.value : x)) })} />
              <button className="btn ghost small" onClick={() => patch(i, { paths: t.paths.filter((_, j) => j !== k) })}>
                −
              </button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => patch(i, { paths: [...t.paths, ""] })}>
            + path
          </button>
        </section>
      ))}
      <button
        className="btn"
        onClick={() =>
          setTeams([
            ...teams,
            {
              id: `team-${teams.length + 1}`,
              name: "New Team",
              color: "#00f0ff",
              brainstormWarnTokens: BRAINSTORM_WARN_DEFAULT,
              brainstormRestartTokens: BRAINSTORM_RESTART_DEFAULT,
              leadFlagTokens: LEAD_FLAG_DEFAULT,
              leadAutoHandoffTokens: LEAD_AUTO_HANDOFF_DEFAULT,
              leadHardCapTokens: LEAD_HARD_CAP_DEFAULT,
              lanes: [],
              paths: [],
            },
          ])
        }
      >
        + Add team
      </button>
      <details className="cast-panel">
        <summary className="cast-toggle">Cast reference (10 classes)</summary>
        <div className="cast-grid">
          {ARCHETYPES.map((a) => (
            <div key={a.type} className="cast-item">
              <Avatar id={`cast-${a.type}`} provider={a.sampleProv} agentType={a.type} size={32} />
              <div className="cast-meta">
                <div className="cast-name">{AGENT_TYPE_NAME[a.type]}</div>
                <div className="muted small">{a.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </Modal>
  );
}
