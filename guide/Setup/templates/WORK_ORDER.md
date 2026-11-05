# Work order template

A Planner (a strong model) fills this in for one task; a cheaper executor follows it exactly.
A work order is narrower than a spec. It says *how*, never *what the product should do*. If writing it
needs a design decision, stop and tell the Lead.
Keep it under about 150 lines. Every section is required: write "none" rather than deleting one.

> **Why this exists:** a strong model decides and a cheap model does the clear work. The order must be
> exact enough that the cheap model needs no judgment, and it must say when to stop.

```
WORK ORDER: <TASK-ID>   PLANNER: <agent>   BASE: <branch> @ <sha>
EXECUTOR: <role>        REVIEW: <role, other family from the executor>

## Goal (2-3 lines)
<What changes, in plain words. Link the spec section if there is one.>

## Files (exhaustive; anything else is out of scope)
| File | Change | Functions / sections |
|---|---|---|
| src/foo.<ext> | edit | `bar()`, `on_baz()` |
| tests/test_foo.<ext> | new | |

## Steps (in order; each one small enough to check)
1. <Exact change. Name the function, the condition and the value. Quote the current line you expect
   to find (file:line) so the executor can tell when the tree has drifted.>
2. ...

## Tests to add
- <test name>: <setup> -> <assert>.
  Planted-bug check: <what to break on purpose, and the failure you expect>. Revert it afterwards.
  (Why: a test that cannot fail proves nothing.)

## Verification (run exactly; paste the raw output into the report)
- `<TEST_COMMAND>` -> expect `<N> passed / 0 failed` (baseline was <M>).
- `git diff --stat` -> expect only the files above.
- <Invariant checks from AGENTS.md: <INVARIANTS>, each with the expected value or "unchanged".>

## Stop conditions (stop and report; do not work around)
- The quoted line in a step is not where this order says it is (the tree has drifted).
- A change outside the Files table seems needed.
- A test fails for a reason the steps do not explain.
- Anything touching <INVARIANTS> that this order does not name.

## Out of scope (do not touch)
- <explicit list>
```
