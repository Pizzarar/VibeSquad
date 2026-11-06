import { execFileSync } from "node:child_process";

// Reads a GENERIC credential (as written by `cmdkey /generic:<target> /user:<u> /pass:<p>`) via advapi32 CredReadW.
// The target arrives through the VS_CRED_TARGET env var; it is never interpolated into this script or argv.
const READ_CRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VsCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buf);
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) return "";
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Encoding.Unicode.GetString(b);
    } finally { CredFree(p); }
  }
}
'@
$v = [VsCred]::Read($env:VS_CRED_TARGET)
if ($null -eq $v) { exit 3 }
[Console]::Out.Write($v.TrimEnd([char]0))
`;

/** Reads a Windows generic credential; returns null when missing, unsupported, or on any error. */
export function readCredential(target, { exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== "win32" || !target) return null;
  try {
    const out = exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", READ_CRED_SCRIPT], {
      env: { ...process.env, VS_CRED_TARGET: String(target) },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true,
    });
    const s = Buffer.isBuffer(out) ? out.toString("utf8") : out;
    return typeof s === "string" && s.length ? s : null;
  } catch {
    return null;
  }
}

/** env[envVar] if non-empty, else the credential at `target`; throws (without any value) when required and absent. */
export function resolveSecret({ envVar, target, required = false }, { env = process.env, read = readCredential } = {}) {
  const fromEnv = envVar ? env[envVar] : undefined;
  if (fromEnv) return fromEnv;
  const fromStore = target ? read(target) : null;
  if (fromStore) return fromStore;
  if (required) {
    throw new Error(
      `Missing secret ${envVar || "(no env var)"}: set it in the environment or store it with ` +
        `\`cmdkey /generic:${target} /user:vibesquad /pass\` (credential target "${target}").`,
    );
  }
  return null;
}

/** Returns a copy of baseEnv with each `NAME: { envVar, target, required }` spec resolved; missing optional ones omitted. */
export function withSecretEnv(baseEnv, specs, deps) {
  const out = { ...baseEnv };
  for (const [name, spec] of Object.entries(specs || {})) {
    const v = resolveSecret(spec, deps);
    if (v != null) out[name] = v;
  }
  return out;
}
