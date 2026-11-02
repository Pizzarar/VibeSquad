import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { readSquads } from "../shared/squads";
import { useLiveAgents } from "./agents";
import { buildSquads, type LaneRow, type SquadRow } from "./model";

type Styles = ReturnType<(typeof makeStyles)>;

function makeStyles({ theme, layout }: Pick<PluginScreenProps, "theme" | "layout">) {
  const c = theme.colors;
  const pad = layout.compact ? 12 : 24;
  return {
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: pad, gap: layout.compact ? 12 : 16 },
    center: { flex: 1, padding: pad, gap: 12, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: c.surface0 },
    title: { color: c.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: "600" as const },
    muted: { color: c.foregroundMuted, fontSize: 13 },
    danger: { color: c.statusDanger, fontSize: 13 },
    card: { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: layout.compact ? 10 : 14, gap: 8 },
    cardHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    squadName: { color: c.foreground, fontSize: 16, fontWeight: "600" as const, flex: 1 },
    badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: c.statusWarning },
    badgeText: { color: c.surface0, fontSize: 12, fontWeight: "700" as const },
    lane: { gap: 4, paddingVertical: 6, borderTopColor: c.border, borderTopWidth: 1 },
    laneHead: {
      flexDirection: (layout.compact ? "column" : "row") as "column" | "row",
      alignItems: (layout.compact ? "flex-start" : "center") as "flex-start" | "center",
      gap: layout.compact ? 4 : 12,
    },
    laneName: { color: c.foreground, fontSize: 14, flex: layout.compact ? undefined : 1 },
    laneDone: { color: c.foregroundMuted, fontSize: 14, flex: layout.compact ? undefined : 1 },
    counts: { flexDirection: "row" as const, gap: 10, flexWrap: "wrap" as const },
    count: { color: c.foregroundMuted, fontSize: 12 },
    countOn: { color: c.foreground, fontSize: 12 },
    needs: { color: c.statusWarning, fontSize: 12 },
    button: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: c.accent },
    buttonText: { color: c.accentForeground, fontSize: 14 },
  };
}

function Count({ n, label, s }: { n: number; label: string; s: Styles }) {
  return <Text style={n > 0 ? s.countOn : s.count}>{`${n} ${label}`}</Text>;
}

function Lane({ row, s }: { row: LaneRow; s: Styles }) {
  const code = row.lane.code ? `${row.lane.code} · ` : "";
  const done = row.lane.state === "done";
  return (
    <View style={s.lane}>
      <View style={s.laneHead}>
        <Text style={done ? s.laneDone : s.laneName} numberOfLines={1}>
          {`${code}${row.lane.name}${done ? " (done)" : ""}`}
        </Text>
        <View style={s.counts}>
          <Count n={row.leads} label={row.leads === 1 ? "Lead" : "Leads"} s={s} />
          <Count n={row.buddies} label={row.buddies === 1 ? "Buddy" : "Buddies"} s={s} />
          <Count n={row.workers} label={row.workers === 1 ? "worker" : "workers"} s={s} />
          {row.running > 0 ? <Text style={s.count}>{`${row.running} running`}</Text> : null}
        </View>
      </View>
      {row.needsYou.map((reason) => (
        <Text key={reason} style={s.needs} numberOfLines={2}>{`needs you · ${reason}`}</Text>
      ))}
    </View>
  );
}

function SquadCard({ row, s }: { row: SquadRow; s: Styles }) {
  return (
    <View style={s.card} accessibilityLabel={`Squad ${row.squad.name}`}>
      <View style={s.cardHead}>
        <Text style={s.squadName} numberOfLines={1}>{row.squad.name}</Text>
        <Text style={s.muted}>{`${row.agents} agents`}</Text>
        {row.needsYou > 0 ? (
          <View style={s.badge}>
            <Text style={s.badgeText}>{`${row.needsYou} needs you`}</Text>
          </View>
        ) : null}
      </View>
      {row.lanes.length === 0 ? <Text style={s.muted}>No lanes</Text> : row.lanes.map((l) => <Lane key={l.lane.id} row={l} s={s} />)}
    </View>
  );
}

export function makeSquadsScreen(openSettings: () => void) {
  return function SquadsScreen({ theme, layout }: PluginScreenProps) {
    const s = useMemo(() => makeStyles({ theme, layout }), [theme, layout.compact]);
    const read = useRpc(readSquads);
    const teams = useQuery({ queryKey: ["squads.read"], queryFn: () => read({}), refetchInterval: 15_000 });
    const enabled = teams.data?.status === "ready";
    const agents = useLiveAgents(enabled);
    const rows = useMemo(
      () => (teams.data?.status === "ready" && agents ? buildSquads(teams.data.teams, agents) : null),
      [teams.data, agents],
    );

    if (teams.isPending) return <View style={s.center}><Text style={s.muted}>Loading Squads…</Text></View>;
    if (teams.isError) return <View style={s.center}><Text style={s.danger}>{String(teams.error)}</Text></View>;
    const data = teams.data;
    if (data.status === "off") {
      return (
        <View style={s.center}>
          <Text style={s.title}>Enable in settings</Text>
          <Text style={s.muted}>VibeSquad screens are off. Turn them on in this plugin's settings.</Text>
          <Pressable accessibilityRole="button" onPress={openSettings} style={s.button}>
            <Text style={s.buttonText}>Open settings</Text>
          </Pressable>
        </View>
      );
    }
    if (data.status === "error") return <View style={s.center}><Text style={s.danger}>{data.error}</Text></View>;
    if (!rows) return <View style={s.center}><Text style={s.muted}>Loading agents…</Text></View>;
    const total = rows.reduce((n, r) => n + r.needsYou, 0);
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        <Text style={s.muted}>{`${rows.length} Squads · ${total} need you · read-only`}</Text>
        {rows.map((r) => <SquadCard key={r.squad.id} row={r} s={s} />)}
      </ScrollView>
    );
  };
}
