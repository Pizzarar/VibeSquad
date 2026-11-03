// Preload injected via NODE_OPTIONS="--import file:///.../windows-hide-preload.mjs" on Windows
// so Paseo daemon supervisor, worker, plugin-host, and child CLI processes never flash console windows.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

if (process.platform === "win32" && !childProcess.__vibesquadWindowsHidePatched) {
  const origSpawn = childProcess.spawn;
  const origFork = childProcess.fork;
  const origExec = childProcess.exec;
  const origExecFile = childProcess.execFile;

  childProcess.spawn = function patchedSpawn(command, args, options) {
    if (Array.isArray(args)) {
      const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
      return origSpawn.call(this, command, args, opts);
    }
    if (args && typeof args === "object") {
      return origSpawn.call(this, command, [], { windowsHide: true, ...args });
    }
    const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
    return origSpawn.call(this, command, [], opts);
  };

  childProcess.fork = function patchedFork(modulePath, args, options) {
    if (Array.isArray(args)) {
      const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
      return origFork.call(this, modulePath, args, opts);
    }
    if (args && typeof args === "object") {
      return origFork.call(this, modulePath, [], { windowsHide: true, ...args });
    }
    const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
    return origFork.call(this, modulePath, [], opts);
  };

  childProcess.exec = function patchedExec(command, options, callback) {
    if (typeof options === "function") {
      return origExec.call(this, command, { windowsHide: true }, options);
    }
    const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
    return origExec.call(this, command, opts, callback);
  };

  childProcess.execFile = function patchedExecFile(file, args, options, callback) {
    if (typeof args === "function") {
      return origExecFile.call(this, file, [], { windowsHide: true }, args);
    }
    if (Array.isArray(args)) {
      if (typeof options === "function") {
        return origExecFile.call(this, file, args, { windowsHide: true }, options);
      }
      const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
      return origExecFile.call(this, file, args, opts, callback);
    }
    if (args && typeof args === "object") {
      const cb = typeof options === "function" ? options : callback;
      return origExecFile.call(this, file, [], { windowsHide: true, ...args }, cb);
    }
    const opts = options && typeof options === "object" ? { windowsHide: true, ...options } : { windowsHide: true };
    const cb = typeof options === "function" ? options : callback;
    return origExecFile.call(this, file, [], opts, cb);
  };

  Object.defineProperty(childProcess, "__vibesquadWindowsHidePatched", {
    value: true,
    enumerable: false,
    configurable: true,
  });

  try {
    syncBuiltinESMExports();
  } catch {}
}
