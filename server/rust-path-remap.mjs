import path from "node:path";

// Release Rust binaries embed source paths (panic Location strings, file!() and debuginfo) for every crate they build:
// registry crates under CARGO_HOME, rust-src under RUSTUP_HOME, our own crate under the repo. On the Windows build host
// these all sit under C:\Users\<user>\, so the public installer leaked the owner's username (audit rn-31b210f0dd49).
// rustc's --remap-path-prefix=FROM=TO rewrites those prefixes; this module builds the flags and hands them to cargo
// without dropping any rustflags the host already has.

/** Env var lookup: case-insensitive on win32 (Windows env names are), exact elsewhere. Returns [key, value] or null. */
function envEntry(env, name, win) {
  if (Object.hasOwn(env, name)) return [name, env[name]];
  if (!win) return null;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return [key, env[key]];
  return null;
}

function dropEnv(env, name, win) {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key === name || (win && key.toUpperCase() === upper)) delete env[key];
}

/**
 * The host-specific prefixes to remap, least specific first. rustc applies the LAST matching --remap-path-prefix, so
 * the home catch-all goes first and the nested CARGO_HOME / RUSTUP_HOME / repo mappings after it win for their paths.
 * win32 adds the `\\?\` verbatim form of each drive path, in case a tool hands rustc a canonicalized path (rustc
 * matches path components literally, so `\\?\C:\x` does not match `C:\x`).
 */
export function hostPathPrefixes({ env = {}, home = "", repoRoots = [], platform = process.platform } = {}) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const clean = (dir) => {
    if (!dir || !p.isAbsolute(dir)) return "";
    const norm = p.normalize(dir);
    const root = p.parse(norm).root;
    if (norm === root) return ""; // never remap a whole drive / "/"
    return norm.length > root.length ? norm.replace(/[\\/]+$/, "") : norm;
  };
  const homeDir = clean(home);
  const cargoHome = clean(envEntry(env, "CARGO_HOME", win)?.[1]) || (homeDir ? p.join(homeDir, ".cargo") : "");
  const rustupHome = clean(envEntry(env, "RUSTUP_HOME", win)?.[1]) || (homeDir ? p.join(homeDir, ".rustup") : "");
  const entries = [
    { role: "home", from: homeDir, to: "/home" },
    ...repoRoots.map((r) => ({ role: "repo", from: clean(r), to: "/vibesquad" })),
    { role: "rustup", from: rustupHome, to: "/rustup" },
    { role: "cargo", from: cargoHome, to: "/cargo" },
  ].filter((e) => e.from);
  const out = [];
  const seen = new Set();
  const push = (e) => {
    const key = win ? e.from.toLowerCase() : e.from;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  for (const e of entries) {
    push(e);
    if (win && /^[A-Za-z]:\\/.test(e.from)) push({ ...e, from: `\\\\?\\${e.from}` });
  }
  return out;
}

/** `--remap-path-prefix=FROM=TO` per prefix, in order (rustc splits on the last "=", so FROM may contain "="). */
export function remapRustflags(prefixes) {
  return prefixes.map(({ from, to }) => `--remap-path-prefix=${from}=${to}`);
}

/**
 * How the remap flags reach cargo without replacing the host's own rustflags. Cargo takes rustflags from ONE source,
 * first match wins: CARGO_ENCODED_RUSTFLAGS, RUSTFLAGS, target.*.rustflags, build.rustflags.
 * - The env already sets CARGO_ENCODED_RUSTFLAGS or RUSTFLAGS (config rustflags are ignored then): the existing flags
 *   stay first and ours are appended, all in CARGO_ENCODED_RUSTFLAGS (\x1f-separated, so paths with spaces survive);
 *   RUSTFLAGS is dropped because cargo would ignore it under the encoded var anyway.
 * - Otherwise: cargo args `--config build.rustflags=[...]` (passed after `tauri build --`). Cargo merges config arrays
 *   across layers, so build.rustflags from any .cargo/config.toml (e.g. +crt-static) is kept and ours is appended.
 *   A target.*.rustflags table would win over build.rustflags; build-desktop's post-build leak scan fails closed then.
 * Returns a copy of `env` (only RUSTFLAGS / CARGO_ENCODED_RUSTFLAGS can change; nothing else is added or removed).
 */
export function rustRemapChildEnv(env, prefixes, { platform = process.platform } = {}) {
  const win = platform === "win32";
  const flags = remapRustflags(prefixes);
  const out = { ...env };
  if (!flags.length) return { env: out, cargoArgs: [], flags, via: "none" };
  const encoded = envEntry(env, "CARGO_ENCODED_RUSTFLAGS", win);
  const plain = envEntry(env, "RUSTFLAGS", win);
  if (encoded || plain) {
    // Same splitting as cargo: encoded "" = no flags; RUSTFLAGS splits on spaces, empty pieces dropped.
    const existing = encoded
      ? encoded[1] === "" || encoded[1] == null
        ? []
        : String(encoded[1]).split("\x1f")
      : String(plain[1] ?? "")
          .split(" ")
          .map((s) => s.trim())
          .filter(Boolean);
    dropEnv(out, "CARGO_ENCODED_RUSTFLAGS", win);
    dropEnv(out, "RUSTFLAGS", win);
    out.CARGO_ENCODED_RUSTFLAGS = [...existing, ...flags].join("\x1f");
    return { env: out, cargoArgs: [], flags, via: "CARGO_ENCODED_RUSTFLAGS" };
  }
  // JSON string/array syntax is valid TOML (\\ and \" escapes are the same), so backslashes survive.
  return { env: out, cargoArgs: ["--config", `build.rustflags=${JSON.stringify(flags)}`], flags, via: "--config build.rustflags" };
}

/**
 * Post-build guard: occurrences of each host prefix (both slash styles, case-insensitive) in a built binary. Returns
 * counts per role only, never the matched text, so the caller can fail the build without printing the username.
 */
export function hostPathHits(buf, prefixes) {
  const hay = Buffer.from(buf).toString("latin1").toLowerCase();
  const hits = {};
  const needles = new Set();
  for (const { role, from } of prefixes) {
    if (from.startsWith("\\\\?\\")) continue; // contains the plain form, which is scanned already
    for (const form of [from, from.replace(/\\/g, "/")]) {
      const needle = Buffer.from(form.toLowerCase(), "utf8").toString("latin1");
      if (!needle || needles.has(needle)) continue;
      needles.add(needle);
      let n = 0;
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
      if (n) hits[role] = (hits[role] ?? 0) + n;
    }
  }
  return hits;
}
