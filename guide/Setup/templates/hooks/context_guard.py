"""PostToolUse hook: warn a session when its context passes the handoff marks.

Why: every turn re-reads the whole context, so long sessions get slow, expensive and fuzzy.
Marks (override with env vars):
  GUARD_SOFT  default 100000 tokens: "plan the handoff" (shown once per session)
  GUARD_HARD  default 150000 tokens: "hand off now" (shown on every tool call)

Which sessions are warned:
  - GUARD_ALWAYS=1: every session that has this hook. Simplest; use it with plain Claude Code (Level 1).
  - otherwise only agents started by VibeSquad (Level 2) whose VS_ROLE environment variable is in GUARD_ROLES
    (comma list, default "lead"; a Buddy has role "brainstorm", add it to warn Buddies too). The runner sets
    VS_ROLE on every agent it starts. A retired agent's role label becomes "former-..." (server/identity.mjs:70),
    so it stops matching on its next start.
With neither, the hook does nothing.

Reads the last assistant usage from the tail of the transcript, so it stays cheap on large files.
Fails silently: a hook must never break your session. Python standard library only.
"""
import json, os, re, sys, tempfile


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


SOFT = env_int("GUARD_SOFT", 100_000)
HARD = env_int("GUARD_HARD", 150_000)
ROLES = {r.strip().lower() for r in os.environ.get("GUARD_ROLES", "lead").split(",") if r.strip()}
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


def role_matches():
    # Level 2: the runner sets VS_ROLE on every agent it starts (runner/runner.mjs:27-28).
    return os.environ.get("VS_ROLE", "").strip().lower() in ROLES


def main():
    if not ALWAYS and not role_matches():
        return
    data = json.load(sys.stdin)
    ctx = last_context(data.get("transcript_path", ""))
    if ctx < SOFT:
        return
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", os.environ.get("VS_AGENT_ID") or data.get("session_id") or "session")
    os.makedirs(STATE_DIR, exist_ok=True)
    state_file = os.path.join(STATE_DIR, key + ".json")
    try:
        with open(state_file) as f:
            state = json.load(f)
    except Exception:
        state = {}
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
