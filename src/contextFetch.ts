// VS-server fetches behind the Composer's @git / @terminal / @chat. Each is time-boxed (CTX_TIMEOUT_MS) and
// throws a short readable Error on failure, so the menu shows a failure state instead of freezing.
import { runnerFetchTimeline } from "./runnerBridge";
import { DEMO } from "./demoFlag";
import { DEMO_DIFF } from "./ChangesPanel";
import { vsListTerminals, vsTerminalOutput } from "./vsShells";
import { vsGitDiff } from "./vsGit";
import {
  chatExcerpt,
  chatLabel,
  CTX_TIMEOUT_MS,
  diffToText,
  gitLabel,
  terminalLabel,
  terminalTail,
  TERMINAL_LINES,
  type CtxSource,
} from "./contextSources";
import { withTimeout } from "./projectContext";

type Picked = Omit<CtxSource, "id">;

async function boxed<T>(p: Promise<T>, what: string): Promise<T> {
  const r = await withTimeout(p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })), CTX_TIMEOUT_MS, null);
  if (r.timedOut || !r.value) throw new Error(`${what} timed out`);
  if (!r.value.ok) throw new Error(`${what} failed: ${r.value.e instanceof Error ? r.value.e.message : String(r.value.e)}`);
  return r.value.v;
}

export async function fetchGitContext(cwd: string, kind: "git" | "git-base"): Promise<Picked> {
  const d: any = DEMO ? DEMO_DIFF : await boxed(vsGitDiff(cwd, kind === "git" ? "uncommitted" : "base"), "git diff");
  const text = diffToText(d?.files ?? []);
  if (!text) throw new Error(kind === "git" ? "no uncommitted changes" : "no changes vs the base branch");
  return { kind, label: gitLabel(kind), text: d?.diffTooLarge ? `${text}\n[this diff is too large; showing the part the server returned]` : text };
}

export async function listTerminalNames(cwd: string, workspaceId: string | null): Promise<Array<{ id: string; name: string }>> {
  if (DEMO) return [{ id: "demo-term-1", name: "Terminal 1" }];
  const terminals = await boxed(vsListTerminals(cwd), "terminal list");
  return terminals.map((t: any) => ({ id: t.id, name: t.title ?? t.name ?? String(t.id).slice(-6) }));
}

export async function fetchTerminalContext(t: { id: string; name: string }): Promise<Picked> {
  const lines = DEMO ? ["\u001b[32m$ npm run build\u001b[0m", "vite v5 building…", "✓ built in 1.2s"] : await boxed(vsTerminalOutput(t.id).then((x) => x.split(/\r?\n/)), "terminal capture");
  const text = terminalTail(lines);
  if (!text) throw new Error("that terminal has no output yet");
  return { kind: "terminal", label: terminalLabel(t.name, TERMINAL_LINES), text };
}

export async function fetchChatContext(agentId: string, title: string): Promise<Picked> {
  const t: any = DEMO
    ? { entries: [{ item: { type: "user_message", text: "Plan the sidebar." } }, { item: { type: "assistant_message", text: "Sidebar plan: three sections." } }] }
    : await boxed(
    runnerFetchTimeline(agentId, { limit: 60 }),
    "chat history",
  );
  const text = chatExcerpt(t?.entries ?? t?.payload?.entries ?? []);
  if (!text) throw new Error("that chat has no messages yet");
  return { kind: "chat", label: chatLabel(title), text };
}
