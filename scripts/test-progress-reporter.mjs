// Silent node --test reporter that scripts/run-tests.mjs adds for the per-file watchdog (scripts/test-watchdog.mjs).
// Its destination file gets one JSON line {t, file} per live event that belongs to a test file. No start/end bookkeeping:
// the file-level event shape differs across node versions and path forms, so the watchdog decides "still running" by
// looking for the file's live process instead. (Node withholds test:start/pass/fail until a test ends; enqueue/dequeue are live.)
export default async function* progressReporter(source) {
  for await (const { data } of source) {
    if (data?.file) yield `${JSON.stringify({ t: Date.now(), file: data.file })}\n`;
  }
}
