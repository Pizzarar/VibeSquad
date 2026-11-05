# Report format (worker to Lead)

Every worker ends its task with this block, saved to the report path the Lead gave it (and pasted in
the final message). The Lead rejects a report that lacks raw output, a diff stat or test output.

```
TASK: <ID>  ROLE: <role>
STATUS: done | stopped | blocked
COMMITS: <hash list or none>
--- git diff --stat ---
<raw output, not retyped>
--- tests ---
<raw output with pass/fail counts>
WRITE-BACK (for the Lead to file):
- <what changed or was decided, for the decision log>
OUT-OF-SCOPE OBSERVATIONS:
- <file:line - what you saw, not fixed>
ESCALATIONS:
- <decisions you did not make>
```

**Reviewers and auditors** use the same header, with this in place of COMMITS and the diff:

```
FINDINGS:
- <file:line> | <severity: blocking / medium / low> | <evidence: the command and its raw output>
```

Rules of thumb:

- Raw output means copied from a captured file. Never typed from memory.
- If a command could not be run, write that, with the error. A reported failure is fine; an invented
  success is not.
- `STATUS: stopped` is a normal outcome (a precondition failed, a stop condition hit). Say which.
- Mark anything you could not check as `UNVERIFIED`.
