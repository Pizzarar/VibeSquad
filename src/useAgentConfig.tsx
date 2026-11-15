import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "./agentTypes";
import { updateAgent, upsertLocalAgent } from "./paseo";
import { DEMO } from "./demoFlag";
import { listProviderModels } from "./paseoProviders";
import { runnerSpawn } from "./runnerBridge";
import { providerSpec } from "./pixel";
import { kindOf } from "./teams";
import { openAgentInTab } from "./panes";
import { setLastBrainstormProfile } from "./pinActions";
import {
  PROVIDER_OPTIONS,
  buildProviderModelOptions,
  configNote,
  modesFor,
  nextModeInCycle,
  normalizeProviderId,
  oppositeProviderTarget,
  providerModelsCache,
  resolveProviderSwitchTarget,
  setModeHelper,
  setModelHelper,
  setThinkingHelper,
  thinkingLevelsFor,
  type ProviderSwitchTarget,
} from "./DrawerHeader";

/**
 * Shared provider / model / mode / thinking state for BOTH DrawerHeader (Psycho) and BoringAgentHeader (Normal).
 * Owns the staged provider switch, the Shift+Tab mode cycle, and the select/input elements, so the two headers
 * only differ in where they place them. (Extracted verbatim from DrawerHeader; the pure helpers stay exported there.)
 */
export type UseAgentConfigArgs = {
  agent: PaseoAgent;
  active: boolean;
  isBs: boolean;
  onSuccessor?: () => void;
  doRestart: (reason: string, pendingPrompt?: string, profileName?: string, model?: string, modeId?: string, thinkingOptionId?: string | null) => Promise<unknown>;
  stagedSwitch?: ProviderSwitchTarget | null;
  onStageSwitch?: (target: ProviderSwitchTarget | null) => void;
};

export function useAgentConfig({ agent, active, isBs, onSuccessor, doRestart, stagedSwitch, onStageSwitch }: UseAgentConfigArgs) {
  const [modeBusy, setModeBusy] = useState(false);
  const [modelValue, setModelValue] = useState(agent.model ?? "");
  const [customModelMode, setCustomModelMode] = useState(false);
  const [liveModels, setLiveModels] = useState<Array<{ id: string }>>(
    () => providerModelsCache.get(agent.provider) ?? [],
  );
  const modelSubmittedRef = useRef<string | null>(null);
  const [modelError, setModelError] = useState("");
  const [reloadError, setReloadError] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [internalStagedSwitch, setInternalStagedSwitch] = useState<ProviderSwitchTarget | null>(null);
  const staged = stagedSwitch !== undefined ? stagedSwitch : internalStagedSwitch;
  const stageSwitch = (target: ProviderSwitchTarget | null) => {
    if (onStageSwitch) onStageSwitch(target);
    else setInternalStagedSwitch(target);
  };
  const effectiveProvider = staged ? staged.provider : agent.provider;
  const effectiveProv = providerSpec(effectiveProvider);
  const submitModel = (next: string) => {
    modelSubmittedRef.current = next;
    setModelError("");
    if (staged) {
      // Staging: pick the model for the *target* provider without touching the old agent.
      setModelValue(next);
      stageSwitch({ ...staged, model: next });
      return;
    }
    setModelBusy(true);
    setModelHelper(agent, next).then((r) => setReloadError(configNote(r))).catch((e) => {
      modelSubmittedRef.current = null;
      setModelValue(agent.model ?? "");
      setModelError(`Model change failed: ${e instanceof Error ? e.message : e}`);
    }).finally(() => setModelBusy(false));
  };
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);

  useEffect(() => {
    if (modelBusy) return; // an in-flight pick wins over stream ticks; the helper rolls back itself on failure
    setModelValue(agent.model ?? "");
    modelSubmittedRef.current = null;
  }, [agent.model, modelBusy]);


  // The internal fallback staging state must not leak into the next agent when this drawer re-renders for a new id.
  useEffect(() => {
    setInternalStagedSwitch(null);
  }, [agent.id]);

  useEffect(() => {
    const cacheKey = effectiveProvider;
    const cached = providerModelsCache.get(cacheKey);
    if (cached && cached.length > 0) {
      setLiveModels(cached);
      return;
    }
    setLiveModels([]);
    if (DEMO || !effectiveProvider) return;
    let cancelled = false;
    listProviderModels(effectiveProvider)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.models)
          ? res.models.filter((m) => typeof m?.id === "string" && m.id.trim().length > 0)
          : [];
        if (list.length > 0) {
          providerModelsCache.set(cacheKey, list);
        }
        setLiveModels(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [effectiveProvider, agent.id]);

  const modelOptions = buildProviderModelOptions(
    effectiveProvider,
    modelValue || staged?.model || agent.model,
    liveModels,
    staged ? null : (agent as unknown as { offered?: { models?: Array<string | { id: string }> } }).offered?.models,
  );
  const modelListId = `drawer-model-list-${agent.id}`;

  const agentLabels = (agent.labels ?? {}) as Record<string, string>;
  const switchTarget = oppositeProviderTarget(agent.provider, agentLabels.profile);
  // Provider switch: one handler shared by the dropdown and the legacy ⇄ button (compact bar + full drawer).
  const switchToProvider = async (targetProviderId: string) => {
    const role = kindOf(agent);
    const target = resolveProviderSwitchTarget(agent.provider, targetProviderId, agentLabels.profile, role === "lead" || isBs ? (role === "lead" ? "lead" : "brainstorm") : undefined);
    if (!target) return;
    const nextProfile = target.profile;
    setSwitchBusy(true);
    setReloadError("");
    try {
      const nextLabels = {
        ...agentLabels,
        ...(nextProfile ? { profile: nextProfile } : {}),
      };
      if (DEMO) {
        upsertLocalAgent({
          ...agent,
          provider: target.provider,
          model: target.model,
          currentModeId: target.modeId,
          labels: nextLabels,
        });
        return;
      }
      if (isBs && nextProfile) setLastBrainstormProfile(nextProfile);
      // A Lead's live labels.profile must stay intact: the successor is spawned, this agent isn't flipped in place.
      if (kindOf(agent) !== "lead") await updateAgent(agent.id, { labels: nextLabels });
      if (kindOf(agent) === "lead" && onSuccessor) {
        onSuccessor();
      } else if (isBs) {
        await doRestart("provider-switch", undefined, nextProfile);
      } else {
        const spawned = await runnerSpawn({
          config: {
            provider: target.provider,
            model: target.model,
            modeId: target.modeId,
            cwd: agent.cwd,
            title: agent.title ?? agent.id,
          },
          labels: nextLabels,
        });
        const newId = spawned?.id;
        if (spawned) upsertLocalAgent(spawned);
        if (newId) openAgentInTab(newId);
      }
    } catch (e) {
      setReloadError(`Switch provider failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSwitchBusy(false);
    }
  };
  const providerSwitchBtn = switchTarget && !agent.archivedAt ? (
    <button
      data-testid="drawer-switch-provider-btn"
      className="btn ghost small"
      title={`Switch this ${kindOf(agent) || "agent"} from ${agent.provider} to ${switchTarget.label.replace("⇄ Switch to ", "")}`}
      disabled={switchBusy}
      onClick={() => void switchToProvider(switchTarget.provider)}
    >
      {switchBusy ? "…" : switchTarget.label}
    </button>
  ) : null;
  const currentProviderId = normalizeProviderId(agent.provider);
  const providerKnown = PROVIDER_OPTIONS.some((o) => o.id === currentProviderId);
  // A Buddy/Lead picks its provider through its profile, which only exists for Claude/Gemini.
  const profileBound = isBs || kindOf(agent) === "lead";
  const providerSelect = (
    <select
      data-testid="drawer-provider-select"
      className="drawer-provider-select"
      style={{ color: effectiveProv.color, borderColor: effectiveProv.color }}
      value={providerKnown ? normalizeProviderId(effectiveProvider) : effectiveProvider}
      disabled={switchBusy || !!agent.archivedAt}
      title={`Provider: ${effectiveProvider}`}
      onChange={(e) => {
        const val = e.target.value;
        // Choosing the current provider again just clears any pending staged switch.
        if (normalizeProviderId(val) === normalizeProviderId(agent.provider)) {
          stageSwitch(null);
          setModelValue(agent.model ?? "");
          return;
        }
        // Stage the switch in the top bar only; the actual restart/creation happens on the next send.
        const role = kindOf(agent);
        const target = resolveProviderSwitchTarget(
          agent.provider,
          val,
          agentLabels.profile,
          role === "lead" || isBs ? (role === "lead" ? "lead" : "brainstorm") : undefined,
        );
        if (!target) return;
        stageSwitch(target);
        setModelValue(target.model);
        if (isBs && target.profile) setLastBrainstormProfile(target.profile);
      }}
    >
      {!providerKnown && <option value={effectiveProvider}>{effectiveProvider}</option>}
      {PROVIDER_OPTIONS.map((o) => (
        <option key={o.id} value={o.id} disabled={profileBound && o.id !== "claude" && o.id !== "antigravity-cli" && o.id !== normalizeProviderId(effectiveProvider)}>
          {o.label}
        </option>
      ))}
    </select>
  );

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const modes = modesFor(agent, DEMO || !!staged);
        if (!modes.length) return;
        const currentMode = staged ? staged.modeId ?? agent.currentModeId ?? null : agent.currentModeId ?? null;
        const next = nextModeInCycle(modes, currentMode);
        if (staged) {
          // Cycle the staged switch's mode, never the old provider's daemon session.
          stageSwitch({ ...staged, modeId: next });
        } else if (!modeBusy) {
          setModeBusy(true);
          setModeHelper(agent, next).then((r) => setReloadError(configNote(r))).catch((e) => setReloadError(String(e instanceof Error ? e.message : e))).finally(() => setModeBusy(false));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, agent, modeBusy, staged]);

  const modeSelect = (() => {
              const modes = modesFor(agent, DEMO || !!staged);
              const stagedModeId = staged ? staged.modeId ?? agent.currentModeId ?? "" : agent.currentModeId ?? "";
              if (!modes.length) return null;
              return (
                <select
                  data-testid="drawer-mode-select"
                  className="drawer-mode-select"
                  style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", height: 20 }}
                  value={stagedModeId}
                  disabled={modeBusy}
                  onChange={(e) => {
                    if (staged) {
                      stageSwitch({ ...staged, modeId: e.target.value });
                      return;
                    }
                    setModeBusy(true);
                    setModeHelper(agent, e.target.value).then((r) => setReloadError(configNote(r))).catch((e2) => setReloadError(String(e2 instanceof Error ? e2.message : e2))).finally(() => setModeBusy(false));
                  }}
                >
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {(m as any).label || (m as any).name || m.id}
                    </option>
                  ))}
                </select>
              );
            })();
  const modes = modesFor(agent, DEMO || !!staged);
  const stagedModeId = staged ? staged.modeId ?? agent.currentModeId ?? "" : agent.currentModeId ?? "";
  const activeModeObj = modes.find((m) => m.id === stagedModeId) ?? modes[0];
  const activeModeLabel = activeModeObj ? ((activeModeObj as any).label || (activeModeObj as any).name || activeModeObj.id) : (stagedModeId || "default");
  const stagedThinking = staged ? staged.thinkingOptionId ?? agent.thinkingOptionId ?? "" : agent.thinkingOptionId ?? "";
  const thinkingLevels = thinkingLevelsFor(agent as any, DEMO || !!staged);
  const thinkingSelect = !thinkingLevels.length ? null : (
            <select
              data-testid="drawer-thinking-select"
              className="drawer-thinking-select"
              style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", height: 20 }}
              value={stagedThinking}
              disabled={thinkingBusy}
              onChange={(e) => {
                if (staged) {
                  stageSwitch({ ...staged, thinkingOptionId: e.target.value || null });
                  return;
                }
                setThinkingBusy(true);
                setThinkingHelper(agent, e.target.value || null).then((r) => setReloadError(configNote(r))).catch((e2) => setReloadError(String(e2 instanceof Error ? e2.message : e2))).finally(() => setThinkingBusy(false));
              }}
            >
              {thinkingLevels.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
              {!thinkingLevels.includes(stagedThinking) && stagedThinking && (
                <option value={stagedThinking}>{stagedThinking}</option>
              )}
            </select>
  );
  const modelControl = customModelMode ? (
    <>
            <input
              data-testid="drawer-model-input"
              className="drawer-model-input"
              aria-label="Model"
              title={`Custom model (${effectiveProvider})`}
              style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", width: 120, height: 18 }}
              list={modelListId}
              value={modelValue}
              autoFocus
              onChange={(e) => setModelValue(e.target.value)}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && (staged || (next !== (agent.model ?? "") && next !== modelSubmittedRef.current))) {
                  submitModel(next);
                } else if (!next) {
                  setModelValue(staged ? (staged.model ?? "") : (agent.model ?? ""));
                }
                setCustomModelMode(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const next = (e.target as HTMLInputElement).value.trim();
                  if (next && (staged || (next !== (agent.model ?? "") && next !== modelSubmittedRef.current))) {
                    submitModel(next);
                  }
                  setCustomModelMode(false);
                } else if (e.key === "Escape") {
                  setModelValue(staged ? (staged.model ?? "") : (agent.model ?? ""));
                  setCustomModelMode(false);
                }
              }}
            />
            <datalist id={modelListId}>
              {modelOptions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
    </>
  ) : (
            <select
              data-testid="drawer-model-select"
              className="drawer-model-input"
              aria-label="Model"
              title={`Model (${effectiveProvider})`}
              style={{ background: "var(--panel-alt)", color: "var(--fg)", border: "1px solid var(--line)", fontSize: 10, padding: "1px 4px", width: 120, height: 20 }}
              value={modelValue || modelOptions[0] || ""}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "__custom__") {
                  setCustomModelMode(true);
                  return;
                }
                const next = val.trim();
                setModelValue(next);
                if (staged || (next && next !== (agent.model ?? "") && next !== modelSubmittedRef.current)) {
                  submitModel(next);
                }
              }}
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value="__custom__">Custom model…</option>
            </select>
  );
  return {
    staged,
    stageSwitch,
    effectiveProvider,
    effectiveProv,
    providerSelect,
    providerSwitchBtn,
    modeSelect,
    thinkingSelect,
    modelControl,
    activeModeLabel,
    stagedThinking,
    modelError,
    reloadError,
    setReloadError,
    switchBusy,
  };
}
