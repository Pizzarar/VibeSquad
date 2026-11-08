// PLAN_CARD_DISMISS_AND_PROFILE_MERGE D1+D2: a send-to / spin-off card id depends only on its content (same in the hub
// bar and the inline Timeline card, unchanged when the Buddy posts again), and dismissals live in the server's
// settings.json so a fresh client with empty localStorage still hides the card.
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(ROOT_DIR, "src");
const read = (p) => fs.readFileSync(join(ROOT_DIR, p), "utf8");

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

const home = fs.mkdtempSync(join(tmpdir(), "vs-card-dismiss-"));
process.env.VIBESQUAD_HOME = home;

const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const ideas = await import("../server/pin-ideas.mjs");
const settings = await import("../server/user-settings.mjs");
const actions = await import("../src/pinActions.ts");

let srv;
let port;
before(async () => {
  srv = createServer(api.createVibesquadMiddleware(ROOT_DIR));
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  port = srv.address().port;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) =>
    realFetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { "x-vibesquad-token": auth.getLocalToken(), ...(init.headers ?? {}) } });
});
after(async () => {
  srv.closeAllConnections?.();
  await new Promise((ok) => srv.close(ok));
  fs.rmSync(home, { recursive: true, force: true });
});

function newClient() {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  actions.resetDismissedCards();
}
const settle = () => actions.loadDismissedCards();
const flush = () => new Promise((r) => setTimeout(r, 150)); // the dismiss POST is fire-and-forget

const fence = (idea) => "Worth a thought.\n```vs:send-to audio\n" + idea + "\n```";
const msg = (id, text) => ({ item: { type: "assistant_message", id, text }, seqStart: id });

test("D1: send-to id is content-derived: same inline and bar, unchanged after the Buddy posts again", () => {
  const first = [msg(1, fence("add a footstep sound"))];
  const later = [...first, msg(2, "Anything else you want to cover?")];
  const barId = ideas.sendToCardId("bs1", ideas.parseSendTo(first[0].item.text));
  // The Timeline parses the code block body itself; it must land on the same id.
  assert.equal(ideas.sendToCardId("bs1", ideas.parseSendTo("vs:send-to audio\nadd a footstep sound")), barId);
  // After the Buddy posts again the newest message has no fence, but the card's id is still derived from the same text.
  assert.equal(ideas.sendToCardId("bs1", ideas.parseSendTo(later[0].item.text)), barId);
  assert.notEqual(ideas.sendToCardId("bs1", { laneId: "audio", text: "a different idea" }), barId);
  assert.equal(ideas.sendToCardId("bs1", { laneId: "audio", text: "  ADD a   footstep\nsound " }), barId, "whitespace and case normalized");
});

test("D1: spin-off id is content-derived and shared by spinOffFrom and the inline card", () => {
  const text = "```vs:spin-off\nAudio | sounds\nUI | menus\n```";
  const bar = ideas.spinOffFrom("bs1", [msg(7, text)]);
  assert.equal(bar.id, ideas.spinOffCardId("bs1", ideas.parseSpinOff(text)));
  assert.equal(ideas.spinOffFrom("bs1", [msg(9, text)]).id, bar.id, "message id no longer matters");
});

test("D1: both render spots use the shared helper, no :inline:<i> fallback for send-to / spin-off", () => {
  const tl = read("src/Timeline.tsx");
  assert.match(tl, /sendToCardId\(agentId \?\? "inline", parsedSendTo\)/);
  assert.match(tl, /spinOffCardId\(agentId \?\? "inline", teams\)/);
  assert.doesNotMatch(tl, /liveSendTo|liveSpinOff/);
  assert.match(read("src/PinIdeas.tsx"), /id: sendToCardId\(agentId, offer\)/);
});

test("D2: dismiss on client A; a fresh client with empty localStorage hides it, and stays hidden", async () => {
  newClient();
  const id = ideas.sendToCardId("bs1", { laneId: "audio", text: "add a footstep sound" });
  assert.equal(actions.isSendToDismissed(id), false);
  await settle();
  actions.dismissSendTo(id);
  await flush();
  assert.deepEqual(settings.loadUserSettings(home).dismissedCards, [id]);

  newClient(); // phone: nothing in localStorage
  assert.equal(globalThis.localStorage.getItem("vibesquad.sendToDismissed"), null);
  await settle();
  assert.equal(actions.isSendToDismissed(id), true);
  assert.equal(actions.isSpinOffDismissed("spin-off:other"), false);
});

test("D2: looks-done and spin-off dismissals are shared too", async () => {
  newClient();
  await settle();
  actions.dismissLooksDone("bs1:42");
  actions.dismissSpinOff("spin-off:bs1:a,b:xyz");
  await flush();
  newClient();
  await settle();
  assert.equal(actions.isLooksDoneDismissed("bs1:42"), true);
  assert.equal(actions.isSpinOffDismissed("spin-off:bs1:a,b:xyz"), true);
});

test("D2: an id dismissed only offline is pushed up on the next load", async () => {
  newClient();
  globalThis.localStorage.setItem("vibesquad.sendToDismissed", JSON.stringify(["send-to:bs9:x:offline"]));
  await settle();
  assert.ok(settings.loadUserSettings(home).dismissedCards.includes("send-to:bs9:x:offline"));
});

test("D2: the list is capped at the newest 500 and other saves neither clobber nor are clobbered", () => {
  const ids = Array.from({ length: 520 }, (_, i) => `c${i}`);
  settings.saveUserSettings({ dismissedCards: ids }, home);
  let got = settings.loadUserSettings(home).dismissedCards;
  assert.equal(got.length, 500);
  assert.equal(got[0], "c20");
  assert.equal(got.at(-1), "c519");
  settings.saveUserSettings({ userName: "Rae" }, home);
  assert.equal(settings.loadUserSettings(home).dismissedCards.length, 500, "unrelated save keeps the list");
  settings.saveUserSettings({ dismissedCards: ["late"] }, home); // a second device adds: merged, not replaced
  got = settings.loadUserSettings(home).dismissedCards;
  assert.equal(got.length, 500);
  assert.equal(got.at(-1), "late");
  assert.equal(got[0], "c21");
});

test("D1 regress: a card dismissed under one Buddy agent id stays dismissed when the resumed Buddy has another id", async () => {
  newClient();
  await settle();
  const offer = { laneId: "usage", text: "track token usage per lane" };
  actions.dismissSendTo(ideas.sendToCardId("rn-before", offer)); // fired while the Buddy was rn-before
  const spin = ideas.parseSpinOff("```vs:spin-off\nAudio | sounds\nUI | menus\n```");
  actions.dismissSpinOff(ideas.spinOffCardId("rn-before", spin));
  await flush();
  newClient(); // reload / resume: empty localStorage, fresh server list
  await settle();
  assert.equal(actions.isSendToDismissed(ideas.sendToCardId("rn-after", offer)), true, "send-to keyed by content, not agent");
  assert.equal(actions.isSpinOffDismissed(ideas.spinOffCardId("rn-after", spin)), true, "spin-off keyed by content, not agent");
  assert.equal(actions.isSendToDismissed(ideas.sendToCardId("rn-after", { laneId: "usage", text: "another idea" })), false);
});

test("D1 regress: ids dismissed in the old agent-prefixed form still hide the card", async () => {
  newClient();
  const offer = { laneId: "usage", text: "legacy dismissed idea" };
  const legacy = ideas.sendToCardId("rn-old", offer).replace("send-to:*:", "send-to:rn-123:");
  globalThis.localStorage.setItem("vibesquad.sendToDismissed", JSON.stringify([legacy]));
  await settle();
  assert.equal(actions.isSendToDismissed(ideas.sendToCardId("rn-new", offer)), true);
});
