import { useEffect, useState } from "react";
import { pruneDismissed, quotaAlertKey, quotaAlertText, QUOTA_DISMISS_KEY, USAGE_URL, visibleQuotaAlerts, type QuotaAlert } from "./usageHelpers";
import "./QuotaAlertBanner.css";

const POLL_MS = 60_000;
const readDismissed = (): string[] => {
  try { const v = JSON.parse(localStorage.getItem(QUOTA_DISMISS_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
};

/** usa-48: red banner per active quota alert (usage payload `quotaAlerts`). App-level; polls lightly and tolerates failures. */
export function QuotaAlertBanner({ onOpenUsage, testAlerts }: { onOpenUsage: () => void; testAlerts?: QuotaAlert[] }) {
  const [alerts, setAlerts] = useState<QuotaAlert[]>(testAlerts ?? []);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (testAlerts) return;
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(USAGE_URL);
        if (!res.ok) return;
        const j = await res.json();
        if (live && Array.isArray(j?.quotaAlerts)) setAlerts(j.quotaAlerts);
      } catch { /* endpoint slow/down: keep last alerts */ }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [testAlerts]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const shown = visibleQuotaAlerts(alerts, dismissed, now);
  if (!shown.length) return null;
  const dismiss = (a: QuotaAlert) => {
    const next = pruneDismissed([...dismissed, quotaAlertKey(a)], now);
    setDismissed(next);
    try { localStorage.setItem(QUOTA_DISMISS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  return (
    <div className="quota-alerts" data-testid="quota-alerts">
      {shown.map((a) => (
        <div key={quotaAlertKey(a)} className="quota-alert" role="alert" data-testid="quota-alert" data-provider={a.provider} data-window={a.window}>
          <span className="quota-alert-text">{quotaAlertText(a, now)}</span>
          <button type="button" className="quota-alert-open" data-testid="quota-alert-open" onClick={onOpenUsage}>Open Usage</button>
          <button type="button" className="quota-alert-dismiss" data-testid="quota-alert-dismiss" aria-label={`Dismiss ${a.provider} ${a.window} quota alert`} onClick={() => dismiss(a)}>✕</button>
        </div>
      ))}
    </div>
  );
}
