// R2 fix r1: the drawer role chip. The reason is its own span that never shrinks; the (role ·) model id ellipsizes first.
import { shortModel } from "./profiles";
import { providerName, spawnChipTitle, spawnReasonLabel } from "./roleSpawn";

export function RoleModelChip({ role, model, reason, staged, provider }: { role?: string | null; model?: string | null; reason: string; staged?: boolean; provider?: string | null }) {
  const short = shortModel(model);
  if (!short && !role && !reason) return null;
  const full = model ?? short;
  const title = spawnChipTitle({ role: role ?? undefined, model: full, reason, staged, provider: provider ? providerName(provider) : undefined });
  return (
    <span className="role-model-chip" data-testid="drawer-role-model" title={title}>
      <span className="rmc-main">{[role, short].filter(Boolean).join(" · ")}</span>
      {reason && <span className="rmc-why" data-testid="drawer-role-model-why" data-reason={reason}> · {spawnReasonLabel(reason)}</span>}
    </span>
  );
}
