# Proof, not prose

"Done, all tests pass" is a claim. Raw output is proof.

Agents can say a job is finished when it is not. For example, a test suite that fails to load can report zero failures. So a report only counts if it has:

- the raw `git diff --stat`
- the raw test output, with counts
- anything else copied from a real run, not retyped

Copy from a captured file. Do not type numbers from memory. If something could not be checked, the report says `UNVERIFIED`. A reported failure is fine. An invented success is not.

The Lead rejects a report without proof and sends the job back.

The format is in [REPORT_FORMAT.md](../Setup/templates/REPORT_FORMAT.md). The rules are in [AGENTS.md](../Setup/templates/AGENTS.md), under "Evidence rules".

Used in [Step 2](../Guide/02-lead-and-workers.md). Part of [ROLO](../ROLO.md): Organize.

> **Aub:** When we first shipped VibeSquad, it wasn't actually applying any profiles or instructions. We went right back to 300k-context chats for a while before anyone noticed.
