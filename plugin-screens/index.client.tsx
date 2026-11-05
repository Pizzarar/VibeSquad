import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { GateSettings } from "./client/settings";
import { makeSquadsScreen } from "./client/squads";

function SquadsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="UsersRound"
      active={currentScreen?.screenId === "squads"}
      onPress={() => openScreen({ screenId: "squads" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "gate", title: "VibeSquad screens", icon: "UsersRound", Component: GateSettings });
  client.addScreen({ id: "squads", title: "Squads", Component: makeSquadsScreen(() => client.openSettings("gate")) });
  client.addSidebarHeaderItem({ id: "squads", title: "Squads", Component: SquadsItem });
  return () => {};
}
