// Silent node --test reporter that scripts/run-tests.mjs adds next to the normal one. It prints nothing; its destination
// file gets {tests, pass, fail, failingFiles} from the run's summary lines ("tests N" / "pass N" / "fail N") and test:fail.
export default async function* summaryReporter(source) {
  const out = { tests: null, pass: null, fail: null, failingFiles: [] };
  const failing = new Set();
  for await (const { type, data } of source) {
    if (type === "test:diagnostic" && !data.file) {
      const m = /^(tests|pass|fail) (\d+)$/.exec(String(data.message));
      if (m) out[m[1]] = Number(m[2]);
    } else if (type === "test:summary" && !data.file && out.tests === null) {
      out.tests = data.counts?.tests ?? null;
      out.pass = data.counts?.passed ?? null;
      out.fail = data.counts?.failed ?? null;
    } else if (type === "test:fail" && data.file) {
      failing.add(data.file);
    }
  }
  out.failingFiles = [...failing];
  yield JSON.stringify(out);
}
