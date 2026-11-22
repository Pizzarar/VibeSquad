// Forge audit R19: off win32, binary resolution requires isFile() + X_OK, so a directory or a non-executable file
// sharing the binary's name is skipped and the PATH search continues.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveExecutable } from '../runner/spawn.mjs';

const fakeFs = (entries) => ({
  existsSync: (p) => p in entries,
  statSync: (p) => {
    if (!(p in entries)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isFile: () => entries[p].kind === 'file' };
  },
  accessSync: (p) => {
    if (!entries[p]?.x) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  },
});

const A = path.join('/opt/a', 'claude');
const B = path.join('/opt/b', 'claude');
const env = { PATH: '/opt/a:/opt/b' };

test('posix: a directory named like the binary is skipped', () => {
  const fsImpl = fakeFs({ [A]: { kind: 'dir', x: true }, [B]: { kind: 'file', x: true } });
  assert.equal(resolveExecutable('claude', { env, platform: 'linux', fsImpl }).file, B);
});

test('posix: a non-executable file named like the binary is skipped', () => {
  const fsImpl = fakeFs({ [A]: { kind: 'file', x: false }, [B]: { kind: 'file', x: true } });
  assert.equal(resolveExecutable('claude', { env, platform: 'linux', fsImpl }).file, B);
});

test('posix: first executable regular file wins; none -> not found', () => {
  const both = fakeFs({ [A]: { kind: 'file', x: true }, [B]: { kind: 'file', x: true } });
  assert.equal(resolveExecutable('claude', { env, platform: 'darwin', fsImpl: both }).file, A);
  const none = fakeFs({ [A]: { kind: 'dir', x: true }, [B]: { kind: 'file', x: false } });
  assert.throws(() => resolveExecutable('claude', { env, platform: 'linux', fsImpl: none }), /not found/);
});
