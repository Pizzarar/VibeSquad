"""PostToolUse hook: warn a session when its context passes the handoff marks.

Why: every turn re-reads the whole context, so long sessions get slow, expensive and fuzzy.
Marks (override with env vars):
  GUARD_SOFT  default 100000 tokens: "plan the handoff" (shown once per session)
  GUARD_HARD  default 150000 tokens: "hand off now" (shown on every tool call)

Which sessions are warned:
  - GUARD_ALWAYS=1: every session that has this hook. Simplest; use it with plain Claude Code.
  - otherwise only agents run under Paseo (Level 2: the PASEO_AGENT_ID variable is set) whose
    Paseo name matches GUARD_NAME (a regex, default skips names starting with "(old)"). Naming convention: start the Lead's name with ★ (VibeSquad does this) or put the word LEAD in
    the Lead's name, and rename a retired Lead so it no longer matches (for example, prefix "(old)"),
    otherwise the old one keeps being warned.
With neither, the hook does nothing.
PASEO_CLI (optional): the command used to run Paseo when looking up the agent's name; default "paseo".

Reads the last assistant usage from the tail of the transcript, so it stays cheap on large files.
Fails silently: a hook must never break your session. Python standard library only.
"""
import json, os, re, shutil, subprocess, sys, tempfile


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


SOFT = env_int("GUARD_SOFT", 100_000)
HARD = env_int("GUARD_HARD", 150_000)
# v2 titles start with the star ("★ Bug1 · fix login"); v1 titles contain LEAD ("★ LEAD · BUG ord1"). Retired names start with (old).
NAME_PATTERN = os.environ.get("GUARD_NAME", r"^(?!\(old\))(?:★|.*LEAD)")
ALWAYS = os.environ.get("GUARD_ALWAYS") == "1"
STATE_DIR = os.path.join(tempfile.gettempdir(), "context_guard")


def last_context(path):
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 400_000))
        lines = f.read().decode("utf-8", "ignore").splitlines()
    for line in reversed(lines):
        if '"usage"' not in line:
            continue
        try:
            u = json.loads(line)["message"]["usage"]
        except Exception:
            continue
        return (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                + u.get("cache_creation_input_tokens", 0))
    return 0


def name_matches(agent_id, state):
    # Level 2 (Paseo): look up the agent's name. Agents may rename themselves after boot, so keep
    # re-checking until a match is cached.
    if state.get("match"):
        return True
    if not re.fullmatch(r"[A-Za-z0-9_-]+", agent_id or ""):
        return False
    binary = shutil.which(os.environ.get("PASEO_CLI", "paseo"))
    if not binary:
        return False
    try:
        out = subprocess.run([binary, "inspect", agent_id, "--json"],
                             capture_output=True, text=True, encoding="utf-8", timeout=8,
                             shell=False).stdout
        info = json.loads(out)
        name = info.get("Name") or info.get("name") or ""
    except Exception:
        return False
    state["match"] = bool(re.search(NAME_PATTERN, name))
    return state["match"]


def main():
    agent_id = os.environ.get("PASEO_AGENT_ID")
    if not agent_id and not ALWAYS:
        return
    data = json.load(sys.stdin)
    ctx = last_context(data.get("transcript_path", ""))
    if ctx < SOFT:
        return
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", agent_id or data.get("session_id") or "session")
    os.makedirs(STATE_DIR, exist_ok=True)
    state_file = os.path.join(STATE_DIR, key + ".json")
    try:
        with open(state_file) as f:
            state = json.load(f)
    except Exception:
        state = {}
    if not ALWAYS and not name_matches(agent_id, state):
        with open(state_file, "w") as f:
            json.dump(state, f)
        return
    if ctx >= HARD:
        msg = (f"CONTEXT {ctx // 1000}k >= {HARD // 1000}k (hard limit). Stop current work and hand off now: "
               "finish LEAD_HANDOFF.md, start a fresh successor session from it, and follow the handoff steps.")
    elif not state.get("soft_warned"):
        state["soft_warned"] = True
        msg = (f"CONTEXT {ctx // 1000}k >= {SOFT // 1000}k. Plan the handoff: no new dispatches, write "
               f"LEAD_HANDOFF.md now, and be handed off before {HARD // 1000}k.")
    else:
        msg = None
    with open(state_file, "w") as f:
        json.dump(state, f)
    if msg:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
