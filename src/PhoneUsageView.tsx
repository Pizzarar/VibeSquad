// usa-57: full-screen Usage dashboard on the phone shell (<=600px). Opened from the ⋯ drawer (phone-usage-btn) or the quota banner.
import { useEffect } from "react";
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
  if (!open) return null;
  return (
    <div className="phone-usage-view" data-testid="phone-usage-view" role="dialog" aria-label="Usage">
      <header className="phone-usage-bar">
        <button type="button" className="btn ghost phone-usage-back" data-testid="phone-usage-back" onClick={closePhoneUsage}>← Back</button>
        <span className="phone-usage-title">Usage</span>
      </header>
      <div className="phone-usage-body"><UsageDashboard /></div>
    </div>
  );
}
