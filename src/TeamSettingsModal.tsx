import { useEffect, useState } from "react";
import { getUserName, loadDesktopStatus, loadUpdaterStatus, loadUserName, saveLanEnabled, saveRemoteEnabled, saveUpdateChannel, saveUserName, useConfigWarnings, useDesktopStatus, useExposedIpsStore, useLanEnabled, useRemoteEnabled, useUpdaterStatus } from "./userName";
import { PaseoSettingsSection } from "./PaseoSettingsSection";
import { PairDeviceModal } from "./PairDeviceModal";
import {
  AGENT_TYPE_NAME,
  BRAINSTORM_RESTART_DEFAULT,
  BRAINSTORM_WARN_DEFAULT,
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  getDiskTeams,
  resetTeamsToDisk,
  saveTeams,
  snapshotTeams,
  type AgentType,
  type TeamDef,
} from "./teams";
import { Avatar } from "./pixel";
import { useDraft } from "./drafts";
import { Field, Modal } from "./TeamActions";
import {
  SHARED_NOTE_PREFIX,
  defaultBriefFor,
  detectNoteWarnings,
  dismissSetupPrompt,
  fetchProfiles,
  importFromPaseo,
  saveProfile,
  seedDefaultPack,
  useProfiles,
  type Profile,
  type Role,
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
  { type: "lead", desc: "Candy head, top hat & pinstripes", sampleProv: "gemini" },
  { type: "retired-lead", desc: "Bucket hat, shades up & a drink", sampleProv: "claude" },
  { type: "brainstorm", desc: "Big headphones & starry eyes", sampleProv: "claude" },
  { type: "implement", desc: "Bandana, tank top & taped fists", sampleProv: "claude" },
  { type: "mechanical", desc: "Ball cap, mustache & coveralls", sampleProv: "codex" },
  { type: "review", desc: "Fedora, trench coat & magnifier", sampleProv: "gemini" },
  { type: "audit", desc: "Hood, green goggles & tactical gear", sampleProv: "deepseek" },
  { type: "spec", desc: "CRT monitor head & brick phone", sampleProv: "gemini" },
  { type: "art", desc: "Beret painter or living paint blob", sampleProv: "gemini" },
  { type: "unknown", desc: "Shadow silhouette, glowing eyes", sampleProv: "codex" },
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

  useEffect(() => {
    setSelected((prev) => {
      if (candidates.length === 0) return prev;
      const next = new Set(prev);
      for (const p of candidates) next.add(p.name);
      return next;
    });
  }, [candidates]);

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
            Seed Default Pack (19)
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
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn ghost small" onClick={() => setSelected(new Set(candidates.map((p) => p.name)))}>
          Select all ({candidates.length})
        </button>
        <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>
          Select none
        </button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={onSeedDefault}>
          Seed Default Pack (19)
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

/** The groups of this editor. The Settings home renders them in separate sections; the modal shows all. */
export type TeamSettingsPart = "account" | "remote" | "update" | "scale" | "paseo" | "profiles" | "teams";

export function TeamSettingsModal({
  onClose,
  embedded = false,
  parts,
  onJumpToProfiles,
}: {
  onClose: () => void;
  /** Render inline (inside the Settings home) instead of as its own modal. */
  embedded?: boolean;
  parts?: TeamSettingsPart[];
  onJumpToProfiles?: () => void;
}) {
  const show = (p: TeamSettingsPart) => !parts || parts.includes(p);
  // The registry this editor started from (and its file revision). Saving merges against it, so a lane the
  // CLI added while the modal was open isn't mistaken for one the user deleted.
  const [base, setBase] = useState(snapshotTeams);
  const [teams, setTeams] = useState<TeamDef[]>(() => JSON.parse(JSON.stringify(base.teams)));
  const [msg, setMsg] = useDraft("settings:msg");
  const { profiles, installedProviders, diff } = useProfiles();
  const [selectedProfileName, setSelectedProfileName] = useState<string>(() => profiles[0]?.name ?? "Lead - Claude");
  const activeProfile = profiles.find((p) => p.name === selectedProfileName) ?? profiles[0];
  const [draftProfile, setDraftProfile] = useState<Profile | null>(() => (activeProfile ? { ...activeProfile } : null));
  const [featuresJson, setFeaturesJson] = useState<string>(() =>
    activeProfile?.featureValues ? JSON.stringify(activeProfile.featureValues) : "{}",
  );
  const [profileDirty, setProfileDirty] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

  const handleSelectProfile = (name: string) => {
    setSelectedProfileName(name);
    setProfileDirty(false);
    const found = profiles.find((p) => p.name === name);
    if (found) {
      setDraftProfile({ ...found });
      setFeaturesJson(found.featureValues ? JSON.stringify(found.featureValues) : "{}");
    }
  };
  const selectProfileForEdit = handleSelectProfile;

  useEffect(() => {
    if (!profiles.length) return;
    const found = profiles.find((p) => p.name === selectedProfileName);
    if (!found) {
      if (profileDirty && draftProfile) return;
      const first = profiles[0];
      setSelectedProfileName(first.name);
      setDraftProfile({ ...first });
      setFeaturesJson(first.featureValues ? JSON.stringify(first.featureValues) : "{}");
      setProfileDirty(false);
    } else if (!draftProfile || !profileDirty) {
      setDraftProfile({ ...found });
      setFeaturesJson(found.featureValues ? JSON.stringify(found.featureValues) : "{}");
    }
  }, [profiles, selectedProfileName, profileDirty]);

  const onSeedDefaultPackInSettings = async () => {
    try {
      const res = await seedDefaultPack();
      setProfileDirty(false);
      if (res.profiles.length > 0) {
        const next = res.profiles.find((p) => p.name === selectedProfileName) ?? res.profiles[0];
        setSelectedProfileName(next.name);
        setDraftProfile({ ...next });
        setFeaturesJson(next.featureValues ? JSON.stringify(next.featureValues) : "{}");
      }
      setMsg(`Seeded ${res.profiles.length} default pack profiles to ~/.vibesquad/profiles.json`);
    } catch (e) {
      setMsg(`Seed default pack error: ${e}`);
    }
  };

  const onNewProfile = () => {
    let idx = 1;
    let candidateName = "Custom - Worker";
    while (profiles.some((p) => p.name === candidateName)) {
      idx += 1;
      candidateName = `Custom - Worker ${idx}`;
    }
    const fresh: Profile = {
      name: candidateName,
      role: "worker",
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "auto",
      thinkingOptionId: "medium",
      notes: `${SHARED_NOTE_PREFIX}\n\nCustom worker profile.`,
      brief: defaultBriefFor(candidateName, "worker"),
    };
    setSelectedProfileName(candidateName);
    setDraftProfile(fresh);
    setFeaturesJson("{}");
    setProfileDirty(true);
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
      setSelectedProfileName(draftProfile.name);
      setProfileDirty(false);
      setMsg(`Saved profile "${draftProfile.name}" to ~/.vibesquad/profiles.json`);
    } catch (e) {
      setMsg(`Profile save error: ${e}`);
    }
  };

  const [nameDraft, setNameDraft] = useState(() => (getUserName() === "you" ? "" : getUserName()));
  const lanEnabled = useLanEnabled();
  const remoteEnabled = useRemoteEnabled();
  const [showPairModal, setShowPairModal] = useState(false);
  const exposedIps = useExposedIpsStore();
  const updaterStatus = useUpdaterStatus();
  const desktopStatus = useDesktopStatus();
  const configWarnings = useConfigWarnings();
  useEffect(() => {
    void loadUserName();
    void fetchProfiles();
    void loadUpdaterStatus();
    void loadDesktopStatus();
  }, []);
  const isHostMode = desktopStatus.serverMode !== "remote";
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
    const r = await saveTeams(clean, { base });
    // Keep editing from what was saved (including anything merged in), not the old snapshot.
    const saved = snapshotTeams();
    setBase(saved);
    setTeams(JSON.parse(JSON.stringify(saved.teams)));
    setMsg(r.disk ? "Saved to browser and teams.json" : "Saved to browser only (no dev server to write teams.json)");
  };

  const footer = (
        <>
          <span className="muted small">{msg}</span>
          <button
            className="btn ghost"
            onClick={() => {
              resetTeamsToDisk();
              setBase(snapshotTeams());
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
  );

  const body = (
    <>
      {show("account") && configWarnings.length > 0 && (
        <section className="ts-team" data-testid="settings-config-warnings" style={{ borderLeftColor: "#ffb000" }}>
          <div className="field-label" style={{ color: "#ffb000" }}>⚠ CONFIG WARNING</div>
          {configWarnings.map((w, idx) => (
            <div key={idx} className="stat-alert small">
              {w}
            </div>
          ))}
        </section>
      )}
      {show("account") && <section className="ts-team" data-testid="user-name-section" data-setting-id="user-name">
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
      </section>}
      {show("account") && <section className="ts-team" data-testid="lan-access-section" data-setting-id="lan">
        <div className="ts-scale-head">
          <div>
            <div className="field-label">ALLOW OTHER DEVICES (HOME LAN / MESHNET)</div>
            <div className="muted small">
              Saved in <code>~/.vibesquad/settings.json</code> so restarts keep your choice. Pairing with a 6-digit code is still required.
              {lanEnabled && exposedIps.length > 0 ? ` Active on: ${exposedIps.join(", ")}.` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
            <button
              type="button"
              className="btn small"
              onClick={() => setShowPairModal(true)}
            >
              📱 Link / Pair a Device
            </button>
          </div>
        </div>
      </section>}
      {show("remote") && (
        <>
          <section className="ts-team" data-testid="remote-control-section" data-setting-id="remote-control">
            <div className="ts-scale-head">
              <div>
                <div className="field-label">REMOTE CONTROL (PASEO RELAY &amp; REMOTE ACCESS)</div>
                <div className="muted small">
                  Allow paired phones, tablets, and laptops to open VibeSquad through Paseo Relay (<code>~/.vibesquad/settings.json</code> → <code>remote.enabled</code>). Fixes &quot;VibeSquad remote access is off on the PC&quot;.
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 700 }}>
                <input
                  type="checkbox"
                  data-testid="settings-remote-enabled-toggle"
                  checked={remoteEnabled}
                  onChange={(e) => {
                    void saveRemoteEnabled(e.target.checked);
                  }}
                />
                <span>{remoteEnabled ? "Enabled" : "Off"}</span>
              </label>
            </div>
          </section>
          <section className="ts-team" data-testid="remote-lan-section">
            <div className="ts-scale-head">
              <div>
                <div className="field-label">DIRECT HOME LAN / NORDVPN MESHNET</div>
                <div className="muted small">
                  Expose HTTPS on port <code>4180</code> over your Home Wi-Fi / LAN or NordVPN Meshnet.
                  {lanEnabled && exposedIps.length > 0 ? ` Active on: ${exposedIps.join(", ")}.` : ""}
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 700 }}>
                <input
                  type="checkbox"
                  data-testid="settings-remote-lan-toggle"
                  checked={lanEnabled}
                  onChange={(e) => {
                    void saveLanEnabled(e.target.checked);
                  }}
                />
                <span>{lanEnabled ? "Enabled" : "Off (loopback only)"}</span>
              </label>
            </div>
          </section>
          <section className="ts-team" data-testid="settings-remote-pair-card">
            <div className="ts-scale-head">
              <div>
                <div className="field-label">LINK / PAIR A DEVICE</div>
                <div className="muted small">
                  Generate a QR code, 6-digit pairing code, or Paseo Relay offer link to connect another PC, phone, or tablet in seconds.
                </div>
              </div>
              <button
                type="button"
                className="btn ok small"
                data-testid="settings-open-pair-device-btn"
                onClick={() => setShowPairModal(true)}
              >
                📱 Link / Pair a Device (QR &amp; 6-Digit Code)
              </button>
            </div>
          </section>
        </>
      )}
      {showPairModal && <PairDeviceModal onClose={() => setShowPairModal(false)} />}
      {show("update") && <section className="ts-team" data-testid="update-channel-section">
        <div className="ts-scale-head">
          <div>
            <div className="field-label">UPDATE CHANNEL (v{updaterStatus.currentVersion})</div>
            <div className="muted small">
              <b>Stable</b> prompts before restarting on new releases. <b>Beta</b> installs rolling pre-releases automatically when no agent turn is mid-flight.
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className={`btn small ${updaterStatus.channel === "stable" ? "on" : "ghost"}`}
              data-testid="update-channel-stable"
              onClick={() => void saveUpdateChannel("stable")}
            >
              Stable
            </button>
            <button
              type="button"
              className={`btn small ${updaterStatus.channel === "beta" ? "on" : "ghost"}`}
              data-testid="update-channel-beta"
              onClick={() => void saveUpdateChannel("beta")}
            >
              Beta
            </button>
          </div>
        </div>
      </section>}
      {show("scale") && <section className="ts-team ts-scale-section" data-testid="ui-scale-section">
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
      </section>}
      {show("paseo") && isHostMode && (
        <PaseoSettingsSection
          lanIpHint={exposedIps[0]}
          onJumpToProfiles={
            onJumpToProfiles ??
            (() => {
              document.querySelector('[data-testid="profiles-settings-section"]')?.scrollIntoView?.({ behavior: "smooth", block: "start" });
            })
          }
        />
      )}
      {show("paseo") && embedded && !isHostMode && (
        <div className="muted small" data-testid="paseo-settings-remote">Paseo settings live on the host machine; this device is connected remotely.</div>
      )}
      {show("profiles") && <section className="ts-team" data-testid="profiles-settings-section" data-setting-id="profiles">
        <div className="ts-scale-head" style={{ marginBottom: 8 }}>
          <div>
            <div className="field-label">AGENT PROFILES (~/.vibesquad/profiles.json · {profiles.length} profiles)</div>
            <div className="muted small">
              Every spawn path (New Agent, Handoff, Brainstorm restart, Inbox topic, Digest) reads this store.
              {diff.some((d) => d.status !== "same") ? " Diff detected against Paseo config." : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn small"
              data-testid="settings-seed-default-pack-btn"
              onClick={() => void onSeedDefaultPackInSettings()}
            >
              Seed Default Pack (19)
            </button>
            <button
              type="button"
              className="btn small"
              data-testid="open-paseo-sync-btn"
              data-setting-id="profile-import"
              onClick={() => setShowImportModal(true)}
            >
              Re-import / Sync from Paseo
            </button>
            <button
              type="button"
              className="btn ghost small"
              data-testid="settings-new-profile-btn"
              onClick={onNewProfile}
            >
              + New Profile
            </button>
          </div>
        </div>
        <div
          data-testid="settings-profile-roster"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 280,
            overflowY: "auto",
            marginBottom: 12,
            padding: 6,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(0,0,0,0.2)",
          }}
        >
          {profiles.map((p) => {
            const d = diff.find((entry) => entry.name === p.name);
            const syncLabel =
              !d || d.status === "same"
                ? "SYNCED"
                : d.status === "modified"
                  ? "MODIFIED"
                  : d.status === "vs-only"
                    ? "VS ONLY"
                    : "PASEO ONLY";
            const isSelected = p.name === selectedProfileName;
            const inst = installedProviders.includes(p.provider);
            return (
              <button
                key={p.name}
                type="button"
                data-testid={`roster-profile-row-${p.name}`}
                onClick={() => handleSelectProfile(p.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: "6px 10px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  color: "inherit",
                  background: isSelected ? "rgba(0, 240, 255, 0.12)" : "rgba(255, 255, 255, 0.02)",
                  border: isSelected ? "1px solid #00f0ff" : "1px solid rgba(255, 255, 255, 0.06)",
                  opacity: inst ? 1 : 0.7,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="chip">{p.role.toUpperCase()}</span>
                  <b>{p.name}</b>
                  <span className="def-badge">
                    {p.provider} / {p.model}
                  </span>
                  {p.modeId && (
                    <span className="def-badge">
                      <b>mode</b> {p.modeId}
                    </span>
                  )}
                  {p.thinkingOptionId && (
                    <span className="def-badge">
                      <b>think</b> {p.thinkingOptionId}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {!inst && <span className="pill diag warn">install {p.provider}</span>}
                  <span className={`pill diag ${syncLabel === "MODIFIED" ? "hot" : syncLabel === "VS ONLY" ? "warn" : "ok"}`}>
                    {syncLabel}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {draftProfile && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="row2">
              <Field label="PROFILE">
                <select
                  value={profiles.some((p) => p.name === selectedProfileName) ? selectedProfileName : ""}
                  data-testid="settings-profile-select"
                  onChange={(e) => selectProfileForEdit(e.target.value)}
                >
                  {!profiles.some((p) => p.name === selectedProfileName) && (
                    <option value="">{draftProfile.name} (unsaved)</option>
                  )}
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
              <Field label="NAME">
                <input
                  value={draftProfile.name}
                  data-testid="settings-profile-name"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setDraftProfile({ ...draftProfile, name: e.target.value });
                  }}
                />
              </Field>
              <Field label="ROLE">
                <select
                  value={draftProfile.role}
                  data-testid="settings-profile-role"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setDraftProfile({ ...draftProfile, role: e.target.value as Role });
                  }}
                >
                  <option value="lead">LEAD</option>
                  <option value="brainstorm">BRAINSTORM</option>
                  <option value="worker">WORKER</option>
                </select>
              </Field>
            </div>
            <div className="row2">
              <Field label="PROVIDER">
                <input
                  value={draftProfile.provider}
                  data-testid="settings-profile-provider"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setDraftProfile({ ...draftProfile, provider: e.target.value });
                  }}
                />
              </Field>
              <Field label="MODEL">
                <input
                  value={draftProfile.model}
                  data-testid="settings-profile-model"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setDraftProfile({ ...draftProfile, model: e.target.value });
                  }}
                />
              </Field>
            </div>
            <div className="row2">
              <Field label="MODE ID">
                <input
                  value={draftProfile.modeId ?? ""}
                  placeholder="auto / accept-edits / build / plan / default"
                  data-testid="settings-profile-mode"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setDraftProfile({ ...draftProfile, modeId: e.target.value || undefined });
                  }}
                />
              </Field>
              <Field label="THINKING">
                <input
                  value={draftProfile.thinkingOptionId ?? ""}
                  placeholder="low / medium / high / default"
                  data-testid="settings-profile-thinking"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setDraftProfile({ ...draftProfile, thinkingOptionId: e.target.value || undefined });
                  }}
                />
              </Field>
              <Field label="FEATURE VALUES (JSON)">
                <input
                  value={featuresJson}
                  data-testid="settings-profile-features"
                  onChange={(e) => {
                    setProfileDirty(true);
                    setFeaturesJson(e.target.value);
                  }}
                />
              </Field>
            </div>
            <Field label="NOTES (PROJECT-NEUTRAL SYSTEM PROMPT LAYER)">
              <textarea
                rows={4}
                value={draftProfile.notes}
                data-testid="settings-profile-notes"
                onChange={(e) => {
                  setProfileDirty(true);
                  setDraftProfile({ ...draftProfile, notes: e.target.value });
                }}
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
      </section>}
      {showImportModal && <ProfileImportModal onClose={() => setShowImportModal(false)} />}
      {show("teams") && <>
      {teams.map((t, i) => (
        // Settings-home jump anchors go on the first team only, so each id stays unique.
        <section key={i} className="ts-team" style={{ borderLeftColor: t.color }} data-setting-id={i === 0 ? "teams" : undefined}>
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
          <label className="muted small" style={{ display: "block", margin: "6px 0" }}>
            <input
              type="checkbox"
              aria-label="Vibe mode"
              checked={t.vibeMode === true}
              onChange={(e) => patch(i, { vibeMode: e.target.checked })}
            />{" "}
            Vibe mode: Buddy auto-dispatches bug fixes, approved plan blocks and parity gaps; features and outward actions wait in one digest
          </label>
          <div className="row2" data-setting-id={i === 0 ? "token-thresholds" : undefined}>
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
          <div className="field-label">TEAMS (id · name · aliases)</div>
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
          <div className="field-label" data-setting-id={i === 0 ? "path-matchers" : undefined}>PATH MATCHERS (folder segment; trailing - = prefix)</div>
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
      </>}
    </>
  );

  if (embedded) {
    return (
      <div className="settings-embedded">
        {body}
        {show("teams") ? <div className="modal-foot">{footer}</div> : msg && <div className="muted small">{msg}</div>}
      </div>
    );
  }
  return (
    <Modal title="Settings" onClose={onClose} wide footer={footer}>
      {body}
    </Modal>
  );
}
