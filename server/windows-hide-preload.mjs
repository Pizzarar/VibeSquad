// Preload injected via NODE_OPTIONS="--import file:///.../windows-hide-preload.mjs" on Windows
// so Paseo daemon supervisor, worker, plugin-host, and child CLI processes never flash console windows.
import childProcess from "node:child_process";
import module, { syncBuiltinESMExports } from "node:module";
import util from "node:util";

function makeCustomPromisifiedExec(fn) {
  return function customPromisifiedExec(...args) {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((res, rej) => {
      resolvePromise = res;
      rejectPromise = rej;
    });
    promise.child = fn.apply(this, [
      ...args,
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          rejectPromise(err);
        } else {
          resolvePromise({ stdout, stderr });
        }
      },
    ]);
    return promise;
  };
}

if (process.platform === "win32") {
  const proto = childProcess.ChildProcess?.prototype;
  if (proto && typeof proto.spawn === "function" && !proto.spawn.__vsWindowsHidePatched) {
    const origProtoSpawn = proto.spawn;
    const patchedProtoSpawn = function patchedProtoSpawn(options) {
      const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
      return origProtoSpawn.call(this, opts);
    };
    Object.defineProperty(patchedProtoSpawn, "__vsWindowsHidePatched", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    proto.spawn = patchedProtoSpawn;
  }

  if (!childProcess.__vibesquadWindowsHidePatched) {
    const origSpawn = childProcess.spawn;
    const origFork = childProcess.fork;
    const origExec = childProcess.exec;
    const origExecFile = childProcess.execFile;

    const patchedSpawn = function patchedSpawn(command, args, options) {
      if (Array.isArray(args)) {
        const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
        return origSpawn.call(this, command, args, opts);
      }
      if (args && typeof args === "object") {
        return origSpawn.call(this, command, [], { ...args, windowsHide: true });
      }
      const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
      return origSpawn.call(this, command, [], opts);
    };

    const patchedFork = function patchedFork(modulePath, args, options) {
      if (Array.isArray(args)) {
        const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
        return origFork.call(this, modulePath, args, opts);
      }
      if (args && typeof args === "object") {
        return origFork.call(this, modulePath, [], { ...args, windowsHide: true });
      }
      const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
      return origFork.call(this, modulePath, [], opts);
    };

    const patchedExec = function patchedExec(command, options, callback) {
      if (typeof options === "function") {
        return origExec.call(this, command, { windowsHide: true }, options);
      }
      const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
      return origExec.call(this, command, opts, callback);
    };

    const patchedExecFile = function patchedExecFile(file, args, options, callback) {
      if (typeof args === "function") {
        return origExecFile.call(this, file, [], { windowsHide: true }, args);
      }
      if (Array.isArray(args)) {
        if (typeof options === "function") {
          return origExecFile.call(this, file, args, { windowsHide: true }, options);
        }
        const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
        return origExecFile.call(this, file, args, opts, callback);
      }
      if (args && typeof args === "object") {
        const cb = typeof options === "function" ? options : callback;
        return origExecFile.call(this, file, [], { ...args, windowsHide: true }, cb);
      }
      const opts = options && typeof options === "object" ? { ...options, windowsHide: true } : { windowsHide: true };
      const cb = typeof options === "function" ? options : callback;
      return origExecFile.call(this, file, [], opts, cb);
    };

    childProcess.spawn = patchedSpawn;
    childProcess.fork = patchedFork;
    childProcess.exec = patchedExec;
    childProcess.execFile = patchedExecFile;

    Object.defineProperty(childProcess, "__vibesquadWindowsHidePatched", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (util.promisify?.custom) {
    if (typeof childProcess.exec === "function" && !childProcess.exec[util.promisify.custom]) {
      Object.defineProperty(childProcess.exec, util.promisify.custom, {
        value: makeCustomPromisifiedExec(childProcess.exec),
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    if (typeof childProcess.execFile === "function" && !childProcess.execFile[util.promisify.custom]) {
      Object.defineProperty(childProcess.execFile, util.promisify.custom, {
        value: makeCustomPromisifiedExec(childProcess.execFile),
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  try {
    (module.syncBuiltinESMExports ?? syncBuiltinESMExports)?.();
  } catch {}
}
