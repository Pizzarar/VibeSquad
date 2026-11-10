// Android blank-screen diagnostics (@and unit-and-p0-white). A WebView that dies at boot shows white and nothing else, so on
// Android this paints window.onerror, unhandled rejections and the last few route/step breadcrumbs as text. Plain DOM on
// purpose: it must work when React never mounted. Hidden until something goes wrong; tap it to dismiss.

export type DiagWindow = Pick<Window, "addEventListener" | "document" | "location"> & { navigator?: { userAgent?: string } };

const MAX_LINES = 12;
const lines: string[] = [];
let box: HTMLElement | null = null;

const stamp = () => new Date().toISOString().slice(11, 23);

function render(doc: Document): void {
  if (!doc.body) return;
  if (!box) {
    box = doc.createElement("pre");
    box.setAttribute("data-testid", "diag-overlay");
    box.setAttribute(
      "style",
      "position:fixed;left:0;right:0;bottom:0;max-height:50vh;overflow:auto;margin:0;padding:8px;z-index:2147483647;white-space:pre-wrap;word-break:break-all;font:11px/1.35 monospace;background:#300;color:#fdd;border-top:2px solid #f55",
    );
    box.addEventListener("click", () => box?.remove());
    doc.body.appendChild(box);
  }
  if (!box.isConnected) doc.body.appendChild(box);
  box.textContent = lines.join("\n");
}

/** Records a step ("route /pair", "pinned", "mounted PhoneCockpit"); shown with the next error as context. */
export function diagStep(step: string): void {
  lines.push(`${stamp()} step: ${step}`);
  if (lines.length > MAX_LINES * 2) lines.splice(0, lines.length - MAX_LINES * 2);
}

export function diagError(kind: string, detail: string, doc?: Document): void {
  lines.push(`${stamp()} ${kind}: ${detail}`);
  if (lines.length > MAX_LINES * 2) lines.splice(0, lines.length - MAX_LINES * 2);
  if (doc) render(doc);
}

/** Installs the listeners once; returns false (and does nothing) off Android. */
export function installDiagOverlay(win: DiagWindow = window): boolean {
  if (!/Android/i.test(win.navigator?.userAgent ?? "")) return false;
  diagStep(`boot ${win.location.href.replace(/([?&](?:code|fp|token)=)[^&#]*/gi, "$1…")}`);
  win.addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    diagError("error", `${ev.message || "script error"} @ ${ev.filename || "?"}:${ev.lineno ?? "?"}:${ev.colno ?? "?"}${ev.error?.stack ? `\n${String(ev.error.stack).split("\n").slice(0, 4).join("\n")}` : ""}`, win.document);
  });
  win.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    diagError("unhandledrejection", String(r?.stack ?? r?.message ?? r).split("\n").slice(0, 4).join("\n"), win.document);
  });
  return true;
}

export const diagLines = (): readonly string[] => lines;

// Side effect on purpose: main.tsx imports this first, so errors thrown while the other modules evaluate are caught too.
if (typeof window !== "undefined") installDiagOverlay();
