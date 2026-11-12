// X1d test fixture: the (id, token) identity a fake-backend context needs, plus a `verifyAgent` that answers the way the
// runner's GET /verify-agent does, from the fixture's own roster. Since X1d every identity tool runs verifyCaller first,
// so a context with an agent id and no token is a 403 (test/vs-mcp.test.mjs covers that); fixtures that exercise the
// tools' own role/lane gates get their caller verified through the real verifyCaller path with this stub.
//
// Rules (no fallback to the claim when the roster knows the id):
//   - the token must be tokenFor(id), else 403 (a wrong or missing token never reaches a tool);
//   - the record comes from the backend roster (fetchAgent / fetchAgents) when it has the id: its labels decide role,
//     lane and team exactly as runner.verifyAgent does (identityOf), so an env/flag claim never wins over the record;
//   - an id the roster does not know answers the fixture's declared identity record (the plain-object contexts of the
//     spawn-config tests have no roster at all); pass `records` to declare more.
// Unlike the runner it does not retire a former-lead / closed / archived record: the tools' own gates for those keep
// producing their messages here, and the runner's retirement 403 is covered by test/runner-auth.test.mjs.
import { findLaneInRegistry, findTeamInRegistry, isHubLane } from "../../server/identity.mjs";

export const tokenFor = (id) => (id ? `tok-${id}` : "");
export const withToken = (identity) => ({ ...identity, token: tokenFor(identity.agentId) });

const clean = (v) => String(v ?? "").trim();
const forbidden = (id) => Object.assign(new Error(`agent token invalid for ${id || "(no VS_AGENT_ID)"} (fixture verifyAgent: wrong or missing token, or an id the roster does not know)`), { status: 403 });

/** The record shape runner.verifyAgent returns, from an agent snapshot (first-class fields win, labels fill in). */
export function recordFromAgent(a, teams) {
  const labels = a?.labels ?? {};
  const role = clean(a.role ?? labels.role).toLowerCase();
  const lane = clean(a.lane ?? labels.lane ?? labels.lead);
  const team = clean(a.team ?? labels.team);
  const profile = clean(a.profile ?? labels.profile);
  const digestFor = labels.digestFor ? String(labels.digestFor) : null;
  let overlord = false;
  if (teams && role === "lead" && team && lane) {
    const t = findTeamInRegistry(team, teams);
    const l = t ? findLaneInRegistry(lane, teams, t.id)?.lane : null;
    overlord = Boolean(t && l && isHubLane(t, l));
  }
  return { id: a.id, role, lane, team, profile, digest: profile === "Pre-check - Flash" && !!digestFor, digestFor, status: a.status ?? "idle", overlord };
}

/** A tools.mjs identity ({ agentId, team, lane, role }) as the roster record it declares. */
export const recordOf = (identity) => ({ id: identity.agentId, status: "idle", labels: { team: identity.team ?? "", lane: identity.lane ?? "", role: identity.role ?? "" } });

async function fromRoster(backend, id) {
  if (!backend) return null;
  if (typeof backend.fetchAgent === "function") {
    try {
      const a = (await backend.fetchAgent(id))?.agent ?? null;
      if (a && a.id === id) return a;
    } catch { /* an unknown id: fall through to the list */ }
  }
  if (typeof backend.fetchAgents === "function") {
    const res = await backend.fetchAgents({});
    const list = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : [];
    return list.map((e) => e?.agent ?? e).find((x) => x?.id === id) ?? null;
  }
  return null;
}

/** ctx.verifyAgent for a fixture: ({ id, token }) -> the runner-shaped record, or a 403-tagged error. */
export function fakeVerifyAgent({ backend, records = [], teams } = {}) {
  return async ({ id, token }) => {
    if (!id || !token || token !== tokenFor(id)) throw forbidden(id);
    const a = (await fromRoster(backend, id)) ?? records.find((r) => r.id === id) ?? null;
    if (!a) throw forbidden(id);
    return recordFromAgent(a, teams);
  };
}

/** createContext overrides (or plain-object context fields) for a verified fixture caller. */
export function verifiedIdentity(identity, { backend, records = [], teams } = {}) {
  return { identity: withToken(identity), verifyAgent: fakeVerifyAgent({ backend, records: [...records, recordOf(identity)], teams }) };
}
