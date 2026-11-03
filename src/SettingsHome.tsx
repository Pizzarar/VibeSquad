import { useEffect, useRef, useState } from "react";
import { Modal } from "./TeamActions";
import { TeamSettingsModal, type TeamSettingsPart } from "./TeamSettingsModal";
import { PushNotificationControls, playAlertChime } from "./notifications";
import { checkForUpdates, updateLabel, type UpdateCheck } from "./DiagnosticsModal";
import { useProfiles } from "./profiles";
import { useUpdaterStatus } from "./userName";
import { clearSession, isRemote } from "./remoteSession";
import { KeybindingsEditor } from "./KeybindingsEditor";
import {
  allSettings,
  exportPrefs,
  flashSettingTarget,
  getPref,
  importPrefs,
  PREF_DEFAULTS,
  PREF_DEFS,
  prefDef,
  resetPref,
  resetSection,
  searchSettings,
  usePref,
  usePrefsVersion,
  visiblePrefDefs,
  type HomeSection,
  type PrefKey,
  type PrefSection,
  type SettingHit,
} from "./prefs";

const NAV: { id: HomeSection; label: string }[] = [
  { id: "app", label: "App" },
  { id: "chat", label: "Chat" },
  { id: "notifications", label: "Notifications" },
  { id: "newAgent", label: "New Agent defaults" },
  { id: "keys", label: "Keybindings" },
  { id: "team", label: "Team" },
  { id: "paseo", label: "Paseo" },
  { id: "profiles", label: "Profiles" },
  { id: "about", label: "About" },
];
const navLabel = (s: HomeSection) => NAV.find((n) => n.id === s)!.label;
const PREF_SECTIONS = new Set<HomeSection>(["app", "chat", "notifications", "newAgent"]);
const REHOUSED: Partial<Record<HomeSection, TeamSettingsPart[]>> = { team: ["account", "teams"], paseo: ["paseo"], profiles: ["profiles"] };

// The palette ("Settings: <name>") asks for a setting before the home mounts; the home picks it up on open.
let pendingTarget: string | null = null;
export function requestSettingsTarget(id: string): void {
  pendingTarget = id;
  window.dispatchEvent(new CustomEvent("vs:settings-target", { detail: id }));
}

export function SettingsHome(props: { onClose: () => void; onDiagnostics: () => void; onLicenses: () => void; onChecklist: () => void }) {
  const [section, setSection] = useState<HomeSection>("app");
  const [visited, setVisited] = useState<Set<HomeSection>>(() => new Set(["app"]));
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const go = (s: HomeSection) => {
    setSection(s);
    setVisited((v) => (v.has(s) ? v : new Set(v).add(s)));
  };

  const jumpTo = (id: string) => {
    const hit = allSettings().find((s) => s.id === id);
    if (!hit) return;
    setQ("");
    go(hit.section);
    // After the section renders: scroll to the setting's own row (rehoused ones too) and flash it.
    setTimeout(() => paneRef.current && flashSettingTarget(paneRef.current, id), 30);
  };

  useEffect(() => {
    if (pendingTarget) jumpTo(pendingTarget);
    pendingTarget = null;
    const on = (e: Event) => {
      pendingTarget = null;
      jumpTo((e as CustomEvent<string>).detail);
    };
    window.addEventListener("vs:settings-target", on);
    return () => window.removeEventListener("vs:settings-target", on);
  }, []);

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([exportPrefs()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vibesquad-prefs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMsg("Exported app settings");
  };

  const doImport = async (f: File | undefined) => {
    if (!f) return;
    const r = importPrefs(await f.text());
    setMsg(r.ok ? `Imported ${r.applied.length} setting(s)${r.skipped.length ? `, skipped ${r.skipped.length} unknown or invalid` : ""}` : `Import failed: ${r.error}`);
    if (fileRef.current) fileRef.current.value = "";
  };

  const hits = searchSettings(q);
  const searching = q.trim().length > 0;

  return (
    <Modal
      title="Settings"
      onClose={props.onClose}
      wide
      className="settings-home"
      footer={
        <>
          <span className="muted small" data-testid="settings-home-msg">
            {msg}
          </span>
          <button className="btn ghost" data-testid="settings-export" onClick={doExport} title="Save app settings (this device) to a .json file">
            Export…
          </button>
          <button className="btn ghost" data-testid="settings-import" onClick={() => fileRef.current?.click()} title="Load app settings from a .json file">
            Import…
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => void doImport(e.target.files?.[0])} />
          <button className="btn ok" onClick={props.onClose}>
            Done
          </button>
        </>
      }
    >
      <nav className="settings-nav" aria-label="Settings sections">
        <input data-testid="settings-search" autoFocus placeholder="Search settings…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
        {NAV.filter((n) => !isRemote() || n.id !== "paseo").map((n) => (
          <button
            key={n.id}
            className={`settings-nav-item ${!searching && section === n.id ? "on" : ""}`}
            data-testid={`settings-nav-${n.id}`}
            onClick={() => {
              setQ("");
              go(n.id);
            }}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <div className="settings-pane" ref={paneRef} data-testid="settings-pane">
        {searching && <SearchResults hits={hits} q={q} onOpen={jumpTo} />}
        {NAV.filter((n) => (!isRemote() || n.id !== "paseo") && visited.has(n.id)).map((n) => (
          <div key={n.id} hidden={searching || section !== n.id} data-testid={`settings-section-${n.id}`}>
            <h2>
              {n.label}
              {PREF_SECTIONS.has(n.id) && <ResetSectionButton section={n.id as PrefSection} onDone={setMsg} />}
            </h2>
            {n.id === "app" && (
              <p className="settings-note" data-testid="settings-agents-keep-running">
                Agents keep running when you close this window — they live in the Paseo daemon.
              </p>
            )}
            {PREF_SECTIONS.has(n.id) && visiblePrefDefs().filter((d) => d.section === n.id).map((d) => <PrefRow key={d.key} k={d.key} />)}
            {n.id === "notifications" && <SoundTest />}
            {n.id === "app" && (
              <div data-setting-id="ui-scale">
                <TeamSettingsModal embedded parts={["scale"]} onClose={props.onClose} />
              </div>
            )}
            {REHOUSED[n.id] && (
              <TeamSettingsModal embedded parts={REHOUSED[n.id]} onClose={props.onClose} onJumpToProfiles={() => go("profiles")} />
            )}
            {n.id === "keys" && (
              <div data-setting-id="keybindings">
                <KeybindingsEditor />
              </div>
            )}
            {n.id === "about" && <About {...props} />}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SearchResults({ hits, q, onOpen }: { hits: SettingHit[]; q: string; onOpen: (id: string) => void }) {
  if (!hits.length) return <div className="muted" data-testid="settings-search-empty">No settings match “{q.trim()}”.</div>;
  return (
    <div data-testid="settings-search-results">
      {hits.map((h) =>
        h.pref ? (
          <PrefRow key={h.id} k={h.pref} sectionTag={navLabel(h.section)} />
        ) : (
          <div key={h.id} className="settings-row" data-testid="settings-search-hit">
            <div className="settings-row-text">
              <div className="settings-row-label">{h.label}</div>
              <div className="muted small">{navLabel(h.section)}</div>
            </div>
            <button className="btn ghost small" onClick={() => onOpen(h.id)}>
              Open →
            </button>
          </div>
        ),
      )}
    </div>
  );
}

function ResetSectionButton({ section, onDone }: { section: PrefSection; onDone: (m: string) => void }) {
  usePrefsVersion();
  const dirty = PREF_DEFS.some((d) => d.section === section && !d.readonly && !d.hidden && JSON.stringify(PREF_DEFAULTS[d.key]) !== JSON.stringify(getPref(d.key)));
  return (
    <button
      className="btn ghost small"
      data-testid={`settings-reset-${section}`}
      disabled={!dirty}
      onClick={() => {
        const label = navLabel(section as HomeSection);
        if (!window.confirm(`Reset all ${label} settings to their defaults?`)) return;
        resetSection(section);
        onDone(`${label} settings reset to defaults`);
      }}
    >
      Reset section
    </button>
  );
}

function PrefRow({ k, sectionTag }: { k: PrefKey; sectionTag?: string }) {
  const d = prefDef(k);
  const [value, set] = usePref(k);
  const isDefault = value === PREF_DEFAULTS[k];
  return (
    <div className="settings-row" data-setting-id={k} data-testid={`pref-row-${k}`}>
      <div className="settings-row-text">
        <label className="settings-row-label" htmlFor={`pref-${k}`}>
          {d.label}
        </label>
        {sectionTag && <span className="muted small"> · {sectionTag}</span>}
        {d.hint && <div className="muted small">{d.hint}</div>}
      </div>
      <div className="settings-row-control">
        {k === "notify.push" ? <PushNotificationControls /> : <PrefControl k={k} value={value} set={set} />}
        {!d.readonly && (
          <button
            className="btn ghost small"
            data-testid={`pref-reset-${k}`}
            disabled={isDefault}
            title={`Reset to default (${String(PREF_DEFAULTS[k]) || "empty"})`}
            onClick={() => resetPref(k)}
          >
            ↺
          </button>
        )}
      </div>
    </div>
  );
}

function PrefControl({ k, value, set }: { k: PrefKey; value: any; set: (v: any) => void }) {
  const d = prefDef(k);
  const { profiles } = useProfiles();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const id = `pref-${k}`;
  if (d.kind === "bool") return <input id={id} type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />;
  if (d.kind === "enum")
    return (
      <select id={id} value={value} onChange={(e) => set(e.target.value)}>
        {d.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  if (d.kind === "number")
    return (
      <input
        id={id}
        type="number"
        min={d.min}
        max={d.max}
        step={d.step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n) && n >= (d.min ?? -Infinity) && n <= (d.max ?? Infinity)) set(n);
        }}
        onBlur={() => setText(String(value))}
      />
    );
  if (k === "newAgent.profile")
    return (
      <select id={id} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Built-in default</option>
        {value && !profiles.some((p) => p.name === value) && <option value={value}>{value} (missing)</option>}
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    );
  return <input id={id} value={value} placeholder={k === "newAgent.folder" ? "e.g. C:\\Users\\you\\projects\\app" : ""} onChange={(e) => set(e.target.value)} />;
}

function SoundTest() {
  return (
    <div className="settings-row">
      <div className="settings-row-text muted small">The events turned on above alert in this window and in push notifications (phone / lock screen). Push follows the device that changed them last.</div>
      <button className="btn ghost small" data-testid="settings-test-sound" onClick={playAlertChime}>
        ▶ Test sound
      </button>
    </div>
  );
}

function About(props: { onDiagnostics: () => void; onLicenses: () => void; onChecklist: () => void; onClose: () => void }) {
  const updaterStatus = useUpdaterStatus();
  const [upd, setUpd] = useState<UpdateCheck["state"]>("idle");
  return (
    <div data-testid="settings-about">
      <p data-testid="settings-about-version">
        <b>VibeSquad v{updaterStatus.currentVersion}</b> · Channel: <code>{updaterStatus.channel}</code>
      </p>
      <div data-setting-id="update-channel">
        <TeamSettingsModal embedded parts={["update"]} onClose={props.onClose} />
      </div>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          className="btn ghost small"
          data-setting-id="check-updates"
          disabled={upd === "checking"}
          onClick={() => {
            setUpd("checking");
            void checkForUpdates().then((ok) => setUpd(ok ? "ok" : "error"));
          }}
        >
          {updateLabel(upd, updaterStatus.currentVersion)}
        </button>
        <button className="btn ghost small" data-setting-id="diagnostics" data-testid="settings-open-diagnostics" onClick={props.onDiagnostics}>
          🩺 Diagnostics &amp; Logs
        </button>
        <button className="btn ghost small" data-setting-id="licenses" onClick={props.onLicenses}>
          About &amp; Licenses
        </button>
        <button className="btn ghost small" onClick={props.onChecklist}>
          Setup Checklist
        </button>
        {isRemote() && (
          <button
            className="btn ghost small"
            data-testid="settings-unpair-btn"
            onClick={() => {
              clearSession();
              location.reload();
            }}
          >
            Unpair / Forget this device
          </button>
        )}
      </p>
    </div>
  );
}
