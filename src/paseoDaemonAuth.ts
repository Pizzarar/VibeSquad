export type DaemonAuthFailureReason = "password_required" | "incorrect_password" | null;

export type DaemonAuthStatus = {
  ok: boolean;
  required: boolean;
  configured: boolean;
  source: "env" | "file" | "local-credential" | "none";
  password?: string | null;
  localCredential?: string | null;
  error?: string;
  authFailureReason?: DaemonAuthFailureReason;
  unreachable?: boolean;
};

function normalizeReason(val: unknown): DaemonAuthFailureReason {
  if (val === "password_required" || val === "incorrect_password") return val;
  if (typeof val === "string" && val) {
    if (/password[_ ]required/i.test(val)) return "password_required";
    if (/incorrect[_ ]password|invalid[_ ]daemon[_ ]password/i.test(val)) return "incorrect_password";
  }
  return null;
}

export function applyDaemonClientPassword(
  dc: unknown,
  password: string | null | undefined,
  localCredential?: string | null,
): void {
  if (!dc || typeof dc !== "object") return;
  const c = dc as { config?: Record<string, any> };
  if (!c.config || typeof c.config !== "object") return;
  const trimmed = typeof password === "string" ? password.trim() : "";
  const nextConfig: Record<string, any> = {
    ...c.config,
    reconnect: { ...(c.config.reconnect ?? {}), enabled: true },
  };
  if (trimmed) nextConfig.password = trimmed;
  else delete nextConfig.password;
  if (localCredential !== undefined) {
    const trimmedCred = typeof localCredential === "string" ? localCredential.trim() : "";
    if (trimmedCred) nextConfig.localCredential = () => trimmedCred;
    else delete nextConfig.localCredential;
  }
  c.config = nextConfig;
}

export function readClientAuthFailure(dc: unknown, err?: unknown): DaemonAuthFailureReason {
  const clientAny = dc as Record<string, any> | null | undefined;
  const details = clientAny?.getConnectionDetails?.() ?? clientAny?.getConnectionState?.();
  const candidates: unknown[] = [
    details?.authFailureReason,
    clientAny?.authFailureReason,
    (err as Record<string, any> | null | undefined)?.reason,
    (err as Record<string, any> | null | undefined)?.authFailureReason,
    details?.reason,
    err instanceof Error ? err.message : typeof err === "string" ? err : undefined,
  ];
  for (const c of candidates) {
    const r = normalizeReason(c);
    if (r) return r;
  }
  return null;
}

function normalizeSource(source: unknown): "env" | "file" | "local-credential" | "none" {
  return source === "env" || source === "file" || source === "local-credential" ? source : "none";
}

export async function fetchLocalDaemonPassword(
  fetchImpl: typeof fetch = fetch,
): Promise<{
  required: boolean;
  configured: boolean;
  source: "env" | "file" | "local-credential" | "none";
  password: string | null;
  localCredential: string | null;
}> {
  try {
    const res = await fetchImpl("/__vibesquad/paseo/daemon-auth?includePassword=1");
    if (!res.ok) {
      return { required: false, configured: false, source: "none", password: null, localCredential: null };
    }
    const data = (await res.json()) as Record<string, unknown> | null;
    return {
      required: Boolean(data?.required),
      configured: Boolean(data?.configured),
      source: normalizeSource(data?.source),
      password: typeof data?.password === "string" && data.password ? data.password : null,
      localCredential: typeof data?.localCredential === "string" && data.localCredential ? data.localCredential : null,
    };
  } catch {
    return { required: false, configured: false, source: "none", password: null, localCredential: null };
  }
}

export async function fetchDaemonAuthStatus(fetchImpl: typeof fetch = fetch): Promise<DaemonAuthStatus> {
  try {
    const res = await fetchImpl("/__vibesquad/paseo/daemon-auth");
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ...data,
      ok: Boolean(res.ok && data?.ok !== false),
      required: Boolean(data?.required),
      configured: Boolean(data?.configured),
      source: normalizeSource(data?.source),
    };
  } catch (e) {
    return {
      ok: false,
      required: false,
      configured: false,
      source: "none",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function submitDaemonPassword(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonAuthStatus & { status: number }> {
  try {
    const res = await fetchImpl("/__vibesquad/paseo/daemon-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ...body,
      status: res.status,
      ok: Boolean(res.ok && body?.ok !== false),
      required: Boolean(body?.required),
      configured: Boolean(body?.configured),
      source: normalizeSource(body?.source),
      authFailureReason: normalizeReason(body?.authFailureReason),
      error: typeof body?.error === "string" ? body.error : undefined,
      unreachable: typeof body?.unreachable === "boolean" ? body.unreachable : undefined,
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      required: false,
      configured: false,
      source: "none",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function clearDaemonPassword(
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonAuthStatus & { status: number }> {
  try {
    const res = await fetchImpl("/__vibesquad/paseo/daemon-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ...body,
      status: res.status,
      ok: Boolean(res.ok && body?.ok !== false),
      required: Boolean(body?.required),
      configured: Boolean(body?.configured),
      source: normalizeSource(body?.source),
    };
  } catch (e) {
    return {
      status: 0,
      ok: false,
      required: false,
      configured: false,
      source: "none",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
