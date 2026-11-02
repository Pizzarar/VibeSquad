import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { screensGate } from "../shared/squads";

export function GateSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(screensGate);
  const queries = useQueryClient();
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  if (settings.status !== "ready") {
    return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  }
  return (
    <SettingsSection title="Squads home">
      <SettingsCard>
        <SettingsSwitch
          label="Show VibeSquad data"
          hint="Off by default. When on, every client of this host (including relay-paired devices) can read Squad and lane names."
          value={settings.values.enabled}
          disabled={settings.saving}
          onValueChange={(enabled) =>
            void settings.save({ ...settings.values, enabled }, settings.revision).then(() =>
              queries.invalidateQueries({ queryKey: ["squads.read"] }),
            )
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
