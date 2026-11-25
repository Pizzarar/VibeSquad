// PTO v1.2 block T (docs/lanes/playtest-overlay/PLAN_V1_2.md, Tier A security): the per-tester reply thread.
// A bug-tester device never reads the bug-intake agent's raw timeline (that is the Squad's bug-lane Buddy: owner chat, lane
// work, other testers). Instead the server keeps, per tester device id, only (1) the lines that device posted (its delivered
// report cards, its /tester/thread and runner /input lines) and (2) agent replies addressed to one of its own cards through
// `vs inbox reply <cardId>` (POST /__vibesquad/inbox/reply). Stored server-side in <VIBESQUAD_HOME>/tester-threads.json:
// { devices: { <deviceId>: { nextSeq, lines: [{ seq, role, kind, teamId, cardId, text, ts, agentId? }] } } }, locked writes.
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileWithBom } from "./user-settings.mjs";
import { updateJsonFile } from "./file-lock.mjs";

/** Lines kept per device (oldest dropped first). */
export const TESTER_THREAD_KEEP = 500;
/** Max chars of one stored line (a report card's markdown can be long; the thread shows it whole up to this). */
export const TESTER_THREAD_LINE_MAX = 20000;
const ROLES = new Set(["user", "assistant"]);
const KINDS = new Set(["report", "chat", "reply"]);
const CARD_ID_RE = /^idea-\d{1,12}$/;

export function getTesterThreadPath(baseHome) {
  const home = baseHome || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return join(home, "tester-threads.json");
}

/**
 * L1 (review rn-b4d883e5fad2): in-process listeners per device id. A tester's SSE stream subscribes to its own device id and
 * gets a content-free tick ({ seq }) after each line stored under it, never the intake agent's raw timeline activity.
 */
const threadListeners = new Map();
/** Call `cb({ seq })` after each line appended to `deviceId`'s thread; returns the unsubscribe function. */
export function onTesterThreadLine(deviceId, cb) {
  if (!validDeviceId(deviceId) || typeof cb !== "function") return () => {};
  let set = threadListeners.get(deviceId);
  if (!set) threadListeners.set(deviceId, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (!set.size && threadListeners.get(deviceId) === set) threadListeners.delete(deviceId);
  };
}
const notifyThreadLine = (deviceId, seq) => {
  for (const cb of [...(threadListeners.get(deviceId) ?? [])]) {
    try {
      cb({ seq });
    } catch {
      /* one broken stream never blocks the store or the other listeners */
    }
  }
};

const validDeviceId = (id) => typeof id === "string" && id.length > 0 && id.length <= 200 && !["__proto__", "constructor", "prototype"].includes(id);
const devicesOf = (data) => (data && typeof data === "object" && data.devices && typeof data.devices === "object" && !Array.isArray(data.devices) ? data.devices : {});

/**
 * Append one line to `deviceId`'s thread; resolves to the stored line (with its per-device `seq`).
 * line: { role: "user"|"assistant", kind: "report"|"chat"|"reply", teamId, cardId?, text, agentId? }.
 */
export async function appendTesterThreadLine(deviceId, line, baseHome) {
  if (!validDeviceId(deviceId)) throw new Error("tester thread: invalid device id");
  if (!ROLES.has(line?.role) || !KINDS.has(line?.kind)) throw new Error("tester thread: invalid line role/kind");
  const teamId = String(line.teamId ?? "").trim().toLowerCase();
  if (!teamId) throw new Error("tester thread: teamId is required");
  const cardId = typeof line.cardId === "string" && CARD_ID_RE.test(line.cardId) ? line.cardId : null;
  const text = String(line.text ?? "").slice(0, TESTER_THREAD_LINE_MAX);
  let stored = null;
  await updateJsonFile(
    getTesterThreadPath(baseHome),
    (data) => {
      const out = data && typeof data === "object" && !Array.isArray(data) ? data : {};
      const devices = devicesOf(out);
      out.devices = devices;
      const own = Object.prototype.hasOwnProperty.call(devices, deviceId) && devices[deviceId] && typeof devices[deviceId] === "object" ? devices[deviceId] : { nextSeq: 1, lines: [] };
      const lines = Array.isArray(own.lines) ? own.lines : [];
      const seq = Number.isSafeInteger(own.nextSeq) && own.nextSeq > 0 ? own.nextSeq : lines.reduce((m, l) => Math.max(m, Number(l?.seq) || 0), 0) + 1;
      stored = { seq, role: line.role, kind: line.kind, teamId, cardId, text, ts: new Date().toISOString(), ...(line.agentId ? { agentId: String(line.agentId) } : {}) };
      lines.push(stored);
      devices[deviceId] = { nextSeq: seq + 1, lines: lines.slice(-TESTER_THREAD_KEEP) };
      return out;
    },
    { fallback: {} },
  );
  if (stored) notifyThreadLine(deviceId, stored.seq);
  return stored;
}

/** `deviceId`'s stored lines (oldest first), optionally only those on `teamId`. Never another device's. */
export function readTesterThread(deviceId, { teamId = null, baseHome } = {}) {
  if (!validDeviceId(deviceId)) return [];
  const res = readJsonFileWithBom(getTesterThreadPath(baseHome), { label: "~/.vibesquad/tester-threads.json", fallback: null });
  const devices = devicesOf(res?.data);
  const own = Object.prototype.hasOwnProperty.call(devices, deviceId) ? devices[deviceId] : null;
  const lines = Array.isArray(own?.lines) ? own.lines.filter((l) => l && ROLES.has(l.role) && Number.isSafeInteger(l.seq)) : [];
  const want = teamId ? String(teamId).trim().toLowerCase() : null;
  return want ? lines.filter((l) => String(l.teamId ?? "").toLowerCase() === want) : lines;
}

/** True for a card an alpha tester filed (server meta only; never an owner-playtest card). */
export const isTesterCard = (c) => Boolean(c && typeof c.testerDeviceId === "string" && c.testerDeviceId && c.source === "alpha-tester" && c.ownerPlaytest !== true);

/**
 * What `deviceId` may read on `teamId`: its own user lines, plus agent replies whose card (looked up in `cards`, the current
 * inbox) is still that device's own tester card on that Squad. Anything else in the store is dropped (defence in depth: a
 * reply is only ever stored under its card's device, see POST /__vibesquad/inbox/reply).
 */
export function testerThreadLines(deviceId, teamId, cards, baseHome) {
  const byId = new Map((Array.isArray(cards) ? cards : []).filter((c) => c?.id).map((c) => [c.id, c]));
  const team = String(teamId ?? "").trim().toLowerCase();
  return readTesterThread(deviceId, { teamId: team, baseHome }).filter((l) => {
    if (l.role === "user") return true;
    if (l.kind !== "reply" || !l.cardId) return false;
    const card = byId.get(l.cardId);
    return isTesterCard(card) && card.testerDeviceId === deviceId && String(card.teamId ?? "").toLowerCase() === team;
  });
}
