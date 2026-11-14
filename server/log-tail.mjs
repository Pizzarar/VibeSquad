// Read a line-oriented file (team log.jsonl, ~6 MB live) from the end, so a caller wanting the newest lines never reads,
// decodes and splits the whole file on the server event loop (unit-loop-stall).
//
// Lines are split on the "\n" byte (never part of a UTF-8 multi-byte sequence, so a chunk boundary can never cut a
// character in a line we decode); a trailing "\r" is dropped, so CRLF and LF files give the same lines as
// `readFileSync(f, "utf8").split(/\r?\n/)`. Empty lines are skipped (callers all did `.filter(Boolean)` or skipped them).
// A missing file throws like readFileSync does.
import fs from "node:fs";

const CHUNK = 64 * 1024;

function decodeLine(buf) {
  const end = buf.length && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length;
  return end ? buf.toString("utf8", 0, end) : "";
}

/** Shared backwards splitter: feed chunks newest-first, get complete lines newest-first. */
function splitter() {
  let carry = Buffer.alloc(0); // bytes of the line that straddles the previous (later) chunk boundary
  return {
    *push(chunk) {
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        const line = decodeLine(buf.subarray(i + 1, end));
        if (line) yield line;
        end = i;
      }
      carry = Buffer.from(buf.subarray(0, end));
    },
    *finish() {
      const line = decodeLine(carry);
      carry = Buffer.alloc(0);
      if (line) yield line;
    },
  };
}

/** Non-empty lines of `file`, newest first, read backwards in chunks. Stop iterating early to stop reading. */
export function* linesFromEndSync(file, { chunkSize = CHUNK } = {}) {
  const fd = fs.openSync(file, "r");
  try {
    let pos = fs.fstatSync(fd).size;
    const sp = splitter();
    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, chunk, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      yield* sp.push(chunk.subarray(0, got));
    }
    yield* sp.finish();
  } finally {
    fs.closeSync(fd);
  }
}

/** Async twin of linesFromEndSync (reads off the event loop). */
export async function* linesFromEnd(file, { chunkSize = CHUNK } = {}) {
  const fh = await fs.promises.open(file, "r");
  try {
    let pos = (await fh.stat()).size;
    const sp = splitter();
    while (pos > 0) {
      const len = Math.min(chunkSize, pos);
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(chunk, got, len - got, pos + got);
        if (bytesRead <= 0) break;
        got += bytesRead;
      }
      yield* sp.push(chunk.subarray(0, got));
    }
    yield* sp.finish();
  } finally {
    await fh.close();
  }
}

/** Last `n` non-empty lines of `file`, oldest first: `readFileSync(f).split(/\r?\n/).filter(Boolean).slice(-n)`. */
export function tailLinesSync(file, n, opts) {
  const out = [];
  if (n <= 0) return out;
  for (const l of linesFromEndSync(file, opts)) {
    out.push(l);
    if (out.length >= n) break;
  }
  return out.reverse();
}

/** Async tailLinesSync. */
export async function tailLines(file, n, opts) {
  const out = [];
  if (n <= 0) return out;
  for await (const l of linesFromEnd(file, opts)) {
    out.push(l);
    if (out.length >= n) break;
  }
  return out.reverse();
}
