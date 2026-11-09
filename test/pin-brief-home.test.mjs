// PLAN_PIN_BRIEF_HOME B1+B2: a new pin's brief is written before its lane is in teams.json, so the Squad id must
// travel with the write or the brief lands in the installed runtime folder and the Buddy boots with "(no brief yet)".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(ROOT_DIR, "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && context.parentURL?.startsWith(pathToFileURL(SRC_DIR).href)) {
      if (specifier === "./paseo" || specifier === "./PinGrid" || specifier === "./ui" || specifier === "./IdeaInbox") {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
      const parentDir = dirname(fileURLToPath(context.parentURL));
      const tsCandidate = resolve(parentDir, `${specifier}.ts`);
      if (fs.existsSync(tsCandidate)) return nextResolve(pathToFileURL(tsCandidate).href, context);
      if (fs.existsSync(resolve(parentDir, `${specifier}.tsx`))) {
        return { url: `data:text/javascript,${encodeURIComponent(stubFor(specifier))}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function stubFor(specifier) {
  if (specifier === "./paseo") {
    return [
      "export const DEMO = false;",
      "export const getPaseoState = () => ({ conn: 'connected', agents: new Map() });",
      "export const subscribePaseo = () => () => {};",
      ...["archiveAgent", "archiveWorkspace", "detachAgent", "retireAgent", "sendMessage", "updateAgent"].map((n) => `export const ${n} = async () => {};`),
      "export const upsertLocalAgent = () => {};",
    ].join("\n");
  }
  if (specifier === "./IdeaInbox") return `export const parkIdeasInInbox = async () => {};`;
  return `export {};`;
}

// Layout: <base>/runtime is the installed app's rootDir, <base>/MyGame is the Squad's project folder.
const base = fs.mkdtempSync(join(tmpdir(), "vs-pin-brief-home-"));
const runtime = join(base, "runtime");
const project = join(base, "MyGame");
const home = join(base, "home");
for (const d of [runtime, project, home]) fs.mkdirSync(d, { recursive: true });
const teamsFile = join(home, "teams.json");
const writeTeams = () =>
  fs.writeFileSync(teamsFile, JSON.stringify({ teams: [{ id: "mg", name: "MyGame", paths: ["MyGame"], lanes: [{ id: "old", name: "Old", state: "pinned" }] }] }));
writeTeams();

process.env.VIBESQUAD_HOME = home;
process.env.VIBESQUAD_ROOT = runtime;
process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const { createPin } = await import("../src/pinActions.ts");

let srv;
let port;
before(async () => {
  srv = createServer(api.createVibesquadMiddleware(runtime));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  port = srv.address().port;
});
after(async () => {
  srv.closeAllConnections?.();
  await new Promise((ok) => srv.close(ok));
  fs.rmSync(base, { recursive: true, force: true });
});

const doFetch = (url, init = {}) =>
  fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { "x-vibesquad-token": auth.getLocalToken(), ...(init.headers ?? {}) } });
const getBrief = async (lane, teamId) => (await (await doFetch(`/__vibesquad/brainstorm-summary?lane=${lane}${teamId ? `&teamId=${teamId}` : ""}`)).json()).content;
const metricLog = () => {
  const f = join(home, "logs", "mg--newpin.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};

test("createPin: the brief lands in the project folder and a GET returns it", async () => {
  const squad = JSON.parse(fs.readFileSync(teamsFile, "utf8")).teams;
  let fell = false;
  const pin = await createPin("mg", "New pin", "build the thing", {
    fetch: doFetch,
    getTeams: () => squad,
    saveTeams: async (fn) => fn(squad),
    onBriefFallback: () => (fell = true),
  });
  const file = join(project, "docs", "brainstorm", `${pin.lane.id}.md`);
  assert.ok(fs.existsSync(file), `brief at ${file}`);
  assert.ok(!fs.existsSync(join(runtime, "docs", "brainstorm", `${pin.lane.id}.md`)), "nothing in the runtime folder");
  assert.equal(fell, false);
  assert.match(await getBrief(pin.lane.id, "mg"), /build the thing/);
});

test("vs pin new: the brief lands in the project folder and a GET returns it", async () => {
  writeTeams();
  const env = { ...process.env, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: runtime, VIBESQUAD_TEAMS_FILE: teamsFile, PASEO_AGENT_ID: "" };
  const r = spawnSync(process.execPath, ["cli/vs.mjs", "pin", "new", "Cli pin", "--brief", "cli idea", "--team", "mg"], { env, encoding: "utf8", cwd: ROOT_DIR });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(join(project, "docs", "brainstorm", "cli-pin.md")));
  assert.ok(!fs.existsSync(join(runtime, "docs", "brainstorm", "cli-pin.md")));
  const lane = JSON.parse(fs.readFileSync(teamsFile, "utf8")).teams[0].lanes.at(-1);
  assert.equal(lane.id, "cli-pin");
  assert.match(await getBrief("cli-pin"), /cli idea/); // lane now in the registry: resolves without a hint
});

test("fallback: no resolvable project dir in the installed runtime emits the metric and the flag", async () => {
  const res = await doFetch("/__vibesquad/brainstorm-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ laneId: "newpin", content: "# lost\n", teamId: "nope" }),
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.fallback, true);
  assert.ok(fs.existsSync(join(runtime, "docs", "brainstorm", "newpin.md")));
  const logs = fs.readdirSync(join(home, "logs")).map((f) => fs.readFileSync(join(home, "logs", f), "utf8")).join("\n");
  assert.match(logs, /brief-fallback lane=newpin path=/);
  assert.match(logs, /"type":"metric"/);
});

test("no fallback flag when the project folder resolves", async () => {
  const res = await doFetch("/__vibesquad/brainstorm-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ laneId: "fine", content: "# ok\n", teamId: "mg" }),
  });
  assert.equal((await res.json()).fallback, undefined);
});

test("PinIdeas: the 'Pinned' toast carries the fallback warning instead of overwriting it", () => {
  const src = fs.readFileSync(join(SRC_DIR, "PinIdeas.tsx"), "utf8");
  assert.match(src, /showPinToast\(withBriefWarning\(`Pinned \$\{pin\.lane\.name\}`, fellBack\)\)/);
  assert.match(src, /showPinToast\(withBriefWarning\(describeSpinOff\(results\), fellBack\)\)/);
  assert.doesNotMatch(src, /onBriefFallback: warnBriefFallback/);
  assert.match(src, /withBriefWarning = \(msg: string, laneIds: string\[\]\) => \[msg, briefFallbackWarning\(laneIds\)\]\.filter\(Boolean\)\.join\(" · "\)/);
});

test("hub spin-up H2: GET brainstorm-summary returns the Squad's working dir for a hub lane with no agent or lane path, null when none resolves", async () => {
  const hit = await (await doFetch("/__vibesquad/brainstorm-summary?lane=mg&teamId=mg")).json();
  assert.equal(hit.ok, true);
  assert.equal(hit.cwd, project);
  const miss = await (await doFetch("/__vibesquad/brainstorm-summary?lane=ghost&teamId=nope")).json();
  assert.equal(miss.cwd, null);
});
