// Silent node --test reporter that scripts/run-tests.mjs adds for the per-file watchdog (scripts/test-watchdog.mjs).
// Its destination file gets one JSON line per live event of a test file: {t, ev, file}. ev "start" = the file began running
// (test:dequeue of the file-level test), "end" = it finished (test:complete / pass / fail of the file-level test), "touch" =
// any other event (a subtest enqueued/dequeued). Node withholds test:start/pass/fail until a test ends, so a hung test is
// only visible through the enqueue/dequeue events.
export default async function* progressReporter(source) {
  for await (const { type, data } of source) {
    if (!data?.file) continue;
    const top = data.name === data.file;
    let ev = "touch";
    if (top && type === "test:dequeue") ev = "start";
    else if (top && (type === "test:complete" || type === "test:pass" || type === "test:fail")) ev = "end";
    else if (type === "test:start" || type === "test:pass" || type === "test:fail" || type === "test:enqueue" || type === "test:dequeue" || type === "test:complete") ev = "touch";
    else continue;
    yield `${JSON.stringify({ t: Date.now(), ev, file: data.file })}\n`;
  }
}
