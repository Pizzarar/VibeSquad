Real captures (2026-11-06), used by test/runner-limits.test.mjs.
- claude-rate-limit-event.jsonl: the `rate_limit_event` line from `claude -p --input-format stream-json --output-format stream-json --verbose` (v2.1.314). utilization is a 0-1 fraction; resetsAt is epoch seconds.
- agy-usage.txt: stdout of `agy -p /usage` (run with MSYS_NO_PATHCONV=1 under Git Bash). Tab-separated: pool, window label, "<N>%" REMAINING, reset ISO time. agy's ACP server does NOT route slash commands (a `/usage` prompt reaches the model as plain text), so this is a separate poll.
