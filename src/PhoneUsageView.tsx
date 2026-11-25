// usa-57: full-screen Usage dashboard on the phone shell (<=600px). Opened from the ⋯ drawer (phone-usage-btn) or the quota banner.
import { useEffect, useRef } from "react";
import { QuotaAlertBanner } from "./QuotaAlertBanner";
import { UsageDashboard } from "./UsageDashboard";
import { closePhoneUsage, openPhoneUsage, usePhoneUsageOpen } from "./phoneUsageStore";
import { OPEN_USAGE_EVENT } from "./usageHelpers";

export function PhoneUsageView() {
  const open = usePhoneUsageOpen();
  useEffect(() => {
    window.addEventListener(OPEN_USAGE_EVENT, openPhoneUsage);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, openPhoneUsage);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) closePhoneUsage(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    backRef.current?.focus();
    return () => { if (prev && prev.isConnected) prev.focus(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="phone-usage-view" data-testid="phone-usage-view" role="dialog" aria-modal="true" aria-label="Usage">
      <header className="phone-usage-bar">
        <button ref={backRef} type="button" className="btn ghost phone-usage-back" data-testid="phone-usage-back" onClick={closePhoneUsage}>← Back</button>
        <span className="phone-usage-title">Usage</span>
      </header>
      {/* the fixed overlay covers the app-level banner: show the alerts here too (already on Usage, so no Open button) */}
      <QuotaAlertBanner canOpenUsage={false} />
      <div className="phone-usage-body"><UsageDashboard /></div>
    </div>
  );
}
