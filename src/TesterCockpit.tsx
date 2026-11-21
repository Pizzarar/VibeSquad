// E6b (docs/PLAN_E6_TESTER_ROLES.md): the Alpha Tester Desk. A paired device with role "bug-tester" sees only this:
// a header (Squad, connection dot, 🐞 Log Bug, 🔌 Unpair) and a live chat with the Squad's single bug-intake agent.
// The server (E6a) already filters teams/roster to the allowed Squads, so this only picks from what it is given.
import { useEffect, useState } from "react";
import { AgentDrawer } from "./AgentDrawer";
import type { RunnerConn } from "./daemonOverlay";
import { clearSession } from "./remoteSession";
import { findBugLane, type Member, type TeamView } from "./teams";
import { PHONE_BUG_MAX_BYTES, PHONE_BUG_MAX_SHOTS, PHONE_BUG_MIMES, pickBugImages, submitPhoneBug } from "./phoneBugCapture";
import { useAllowedTeams, useDeviceName } from "./userName";

/** The Squad's one bug-intake agent: the bug lane's Buddy, else its Lead, else null (Bug Desk offline). */
export function bugIntakeMember(view: TeamView | undefined): Member | null {
  if (!view) return null;
  const bug = findBugLane(view.team);
  const l = bug ? view.lanes.find((x) => x.lane.id === bug.id) : undefined;
  return l?.brainstorm ?? l?.lead ?? null;
}

function BugSheet({ view, testerName, onClose }: { view: TeamView; testerName: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [shots, setShots] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const bugLane = findBugLane(view.team)?.id ?? "";
  const add = (files: File[]) => setShots((s) => [...s, ...files].slice(0, PHONE_BUG_MAX_SHOTS));
  const addFiles = (list: FileList | null) => {
    const all = Array.from(list ?? []);
    const ok = all.filter((f) => PHONE_BUG_MIMES.includes(f.type) && f.size <= PHONE_BUG_MAX_BYTES);
    if (ok.length < all.length) setErr("Screenshots must be PNG/JPEG/WebP under 8 MB");
    add(ok);
  };
  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      const out = await submitPhoneBug({ text, teamId: view.team.id, bugLaneId: bugLane, ctx: { squad: view.team.id, lane: bugLane, testerDeviceName: testerName || "tester" }, shots });
      if (out.error) setErr(`Saved as #${out.cardId}, not delivered yet: ${out.error}`);
      else {
        setDone(`Sent #${out.cardId}. Thanks!`);
        setText("");
        setShots([]);
      }
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone-bug-scrim" data-testid="tester-bug-sheet" onClick={onClose}>
      <div className="phone-bug-sheet tester-bug-sheet" role="dialog" aria-label="Log a bug" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={text}
          rows={4}
          placeholder="What went wrong? (paste a screenshot here too)"
          aria-label="Bug description"
          data-testid="tester-bug-text"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const imgs = pickBugImages(e.clipboardData?.items as any);
            if (imgs.length) {
              e.preventDefault();
              add(imgs);
            }
          }}
        />
        <div className="tester-bug-row">
          <label className="btn" data-testid="tester-bug-attach">
            🖼 Add screenshot
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>
          {shots.length > 0 && <span data-testid="tester-bug-shots">{shots.length} attached</span>}
        </div>
        {err && <div role="alert" className="tester-bug-err" data-testid="tester-bug-error">{err}</div>}
        {done && <div role="status" data-testid="tester-bug-done">{done}</div>}
        <div className="tester-bug-row end">
          <button type="button" className="btn" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
          <button type="button" className="btn" data-testid="tester-bug-send" disabled={busy || !text.trim() || !bugLane} onClick={() => void send()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TesterCockpit({ views, view, onSquad, runnerConn }: { views: TeamView[]; view: TeamView | undefined; onSquad: (id: string) => void; runnerConn: RunnerConn }) {
  const allowed = useAllowedTeams();
  const deviceName = useDeviceName();
  const [sheet, setSheet] = useState(false);
  const squads = allowed.length ? views.filter((v) => allowed.some((a) => a.toLowerCase() === v.team.id.toLowerCase())) : views;
  const active = (view && squads.find((v) => v.team.id === view.team.id)) ?? squads[0];
  useEffect(() => {
    if (active && view && active.team.id !== view.team.id) onSquad(active.team.id);
  }, [active, view, onSquad]);
  const agent = bugIntakeMember(active);
  const conn = runnerConn === "up" ? "connected" : runnerConn === "down" ? "disconnected" : "connecting";
  return (
    <div className="tester-cockpit" data-testid="tester-cockpit">
      <header className="tester-head">
        <span className={`tester-dot ${conn}`} data-testid="tester-conn" title={`runner: ${conn}`} role="status" aria-label={`Connection ${conn}`} />
        <strong className="tester-title">Alpha Tester Desk</strong>
        {squads.length > 1 ? (
          <select className="tester-squad" data-testid="tester-squad-select" aria-label="Squad" value={active?.team.id ?? ""} onChange={(e) => onSquad(e.target.value)}>
            {squads.map((v) => (
              <option key={v.team.id} value={v.team.id}>{v.team.name}</option>
            ))}
          </select>
        ) : (
          active && <span className="tester-squad-badge" data-testid="tester-squad-badge">{active.team.name}</span>
        )}
        <span className="tester-spacer" />
        <button type="button" className="btn" data-testid="tester-log-bug-btn" disabled={!active} onClick={() => setSheet(true)}>🐞 Log Bug</button>
        <button
          type="button"
          className="btn ghost"
          data-testid="tester-unpair-btn"
          title="Forget this pairing on this device"
          onClick={() => {
            clearSession();
            location.reload();
          }}
        >
          🔌 Unpair
        </button>
      </header>
      <main className="tester-body">
        {agent ? (
          <AgentDrawer key={agent.agent.id} agent={agent.agent} chatOnly onClose={() => {}} onSuccessor={() => {}} />
        ) : (
          <div className="tester-offline" data-testid="tester-offline">
            Bug Desk is offline right now — use 🐞 Log Bug above to drop a bug report + screenshot into the queue.
          </div>
        )}
      </main>
      {sheet && active && <BugSheet view={active} testerName={deviceName ?? ""} onClose={() => setSheet(false)} />}
    </div>
  );
}
