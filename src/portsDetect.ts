// Pure dev-server listening port detection from terminal output chunks + shared per-workspace reactive store.
// Node-importable (no React or DOM imports) so unit tests can import `src/portsDetect.ts` directly.

export interface DetectedPort {
  port: number;
  url: string;
  host: string;
  protocol: 'http' | 'https';
  label?: string;
  lastSeenAt: number;
}

// Strips CSI, OSC, and 2-byte ESC sequences from terminal output chunks.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])|\u009b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

const ERROR_LINE_RE =
  /\b(?:EADDRINUSE|EACCES|address\s+already\s+in\s+use|already\s+in\s+use|port\s+\d+\s+is\s+(?:already\s+)?in\s+use|is\s+in\s+use|failed\s+to\s+bind|cannot\s+listen|permission\s+denied)\b/i;

const EXPLICIT_URL_RE =
  /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(\/[^\s),;'"<>]*)?/gi;

const BARE_HOST_PORT_RE =
  /(?:^|[\s(,@])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(\/[^\s),;'"<>]*)?/gi;

const BARE_LISTEN_PATTERNS: RegExp[] = [
  /\b(?:listening|listens)\s+(?:[\w-]+\s+){0,2}on\s+(?:port\s+|http:\/\/:|https:\/\/:|:)?(\d{1,5})\b/gi,
  /\b(?:started|starting|running|serving|bound|ready)\s+(?:[\w-]+\s+){0,3}(?:on|at)\s+(?:port\s+|:)(\d{1,5})\b/gi,
  /\bport\s+(\d{1,5})\s+(?:is\s+)?(?:listening|ready|open|active)\b/gi,
];

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function normalizeHostForUrl(host: string): string {
  const lower = host.toLowerCase();
  if (lower === '0.0.0.0' || lower === '[::1]' || lower === '[::]' || lower === '::1' || lower === '::') {
    return 'localhost';
  }
  return lower;
}

function cleanUrlPath(rawPath: string | undefined): string {
  if (!rawPath) return '';
  const trimmed = rawPath.replace(/[.,;:!?)'"\]]+$/, '');
  return trimmed === '/' ? '' : trimmed;
}

function extractLineLabel(line: string): string | undefined {
  const m = line.match(/^\s*(?:[➜>•*-]+\s*)?([A-Za-z][A-Za-z0-9 _-]{0,20}):\s+/);
  if (!m) return undefined;
  const candidate = m[1].trim();
  if (/^(?:error|warn|warning|info|debug|http|https|port|listen|listening)$/i.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function mergePort(existing: DetectedPort | undefined, incoming: DetectedPort): DetectedPort {
  if (!existing) return incoming;
  const existingHasPath = /^https?:\/\/[^/]+\/.+/.test(existing.url);
  const incomingHasPath = /^https?:\/\/[^/]+\/.+/.test(incoming.url);
  const preferIncomingUrl =
    incomingHasPath ||
    !existingHasPath ||
    (incoming.protocol === 'https' && existing.protocol === 'http');

  return {
    port: incoming.port,
    url: preferIncomingUrl ? incoming.url : existing.url,
    host: preferIncomingUrl ? incoming.host : existing.host,
    protocol: incoming.protocol === 'https' || existing.protocol === 'https' ? 'https' : 'http',
    label: incoming.label ?? existing.label,
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
  };
}

export function detectPortsInText(text: string, now: number = Date.now()): DetectedPort[] {
  if (!text) return [];
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n|\r/);
  const byPort = new Map<number, DetectedPort>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const isErrorLine = ERROR_LINE_RE.test(line);
    const label = extractLineLabel(line);

    // 1. Explicit http(s):// URLs (allowed even if the line mentions another port was in use)
    EXPLICIT_URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const explicitRanges: Array<[number, number]> = [];
    while ((match = EXPLICIT_URL_RE.exec(line)) !== null) {
      const protocol = match[1].toLowerCase() as 'http' | 'https';
      const host = match[2].toLowerCase();
      const port = Number(match[3]);
      if (!isValidPort(port)) continue;
      const path = cleanUrlPath(match[4]);
      const urlHost = normalizeHostForUrl(host);
      const url = `${protocol}://${urlHost}:${port}${path}`;
      explicitRanges.push([match.index, match.index + match[0].length]);
      byPort.set(
        port,
        mergePort(byPort.get(port), {
          port,
          url,
          host,
          protocol,
          ...(label ? { label } : {}),
          lastSeenAt: now,
        }),
      );
    }

    // Do not match bare host:port or bare "port XXXX" on error / EADDRINUSE lines.
    if (isErrorLine) continue;

    // 2. Bare host:port (e.g. 0.0.0.0:3000, [::1]:4000, 127.0.0.1:8080)
    BARE_HOST_PORT_RE.lastIndex = 0;
    while ((match = BARE_HOST_PORT_RE.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (explicitRanges.some(([s, e]) => start >= s && end <= e)) continue;
      const host = match[1].toLowerCase();
      const port = Number(match[2]);
      if (!isValidPort(port)) continue;
      const path = cleanUrlPath(match[3]);
      const urlHost = normalizeHostForUrl(host);
      const url = `http://${urlHost}:${port}${path}`;
      byPort.set(
        port,
        mergePort(byPort.get(port), {
          port,
          url,
          host,
          protocol: 'http',
          ...(label ? { label } : {}),
          lastSeenAt: now,
        }),
      );
    }

    // 3. Bare listening announcements (e.g. "Listening on port 8080", "Listening on :8080")
    for (const pattern of BARE_LISTEN_PATTERNS) {
      pattern.lastIndex = 0;
      while ((match = pattern.exec(line)) !== null) {
        const port = Number(match[1]);
        if (!isValidPort(port)) continue;
        const host = 'localhost';
        const url = `http://localhost:${port}`;
        byPort.set(
          port,
          mergePort(byPort.get(port), {
            port,
            url,
            host,
            protocol: 'http',
            ...(label ? { label } : {}),
            lastSeenAt: now,
          }),
        );
      }
    }
  }

  return Array.from(byPort.values());
}

// ── Shared per-workspace store ──

const workspacePortsStore = new Map<string, Map<number, DetectedPort>>();
const listeners = new Set<() => void>();
const EMPTY_PORTS: DetectedPort[] = [];
const snapshotCache = new Map<string, DetectedPort[]>();

function normalizeWorkspaceKey(workspaceKey: string): string {
  return (workspaceKey ?? '').trim() || 'default';
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(key: string): DetectedPort[] {
  const portMap = workspacePortsStore.get(key);
  if (!portMap || portMap.size === 0) {
    snapshotCache.delete(key);
    return EMPTY_PORTS;
  }
  const list = Array.from(portMap.values()).sort((a, b) => a.port - b.port);
  snapshotCache.set(key, list);
  return list;
}

export function recordWorkspacePorts(
  workspaceKey: string,
  textChunk: string,
  now: number = Date.now(),
): DetectedPort[] {
  const key = normalizeWorkspaceKey(workspaceKey);
  const detected = detectPortsInText(textChunk, now);
  if (detected.length === 0) {
    return getWorkspacePorts(key);
  }
  const portMap = workspacePortsStore.get(key) ?? new Map<number, DetectedPort>();
  for (const item of detected) {
    portMap.set(item.port, mergePort(portMap.get(item.port), item));
  }
  workspacePortsStore.set(key, portMap);
  const next = updateSnapshot(key);
  notifyListeners();
  return next;
}

export function getWorkspacePorts(workspaceKey: string): DetectedPort[] {
  const key = normalizeWorkspaceKey(workspaceKey);
  return snapshotCache.get(key) ?? EMPTY_PORTS;
}

export function dismissWorkspacePort(workspaceKey: string, port: number): void {
  const key = normalizeWorkspaceKey(workspaceKey);
  const portMap = workspacePortsStore.get(key);
  if (!portMap || !portMap.has(port)) return;
  portMap.delete(port);
  if (portMap.size === 0) {
    workspacePortsStore.delete(key);
  }
  updateSnapshot(key);
  notifyListeners();
}

export function clearWorkspacePorts(workspaceKey?: string): void {
  if (workspaceKey === undefined) {
    if (workspacePortsStore.size === 0) return;
    workspacePortsStore.clear();
    snapshotCache.clear();
    notifyListeners();
    return;
  }
  const key = normalizeWorkspaceKey(workspaceKey);
  if (!workspacePortsStore.has(key)) return;
  workspacePortsStore.delete(key);
  snapshotCache.delete(key);
  notifyListeners();
}

export function subscribeWorkspacePorts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
