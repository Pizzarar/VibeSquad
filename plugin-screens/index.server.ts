import type { PluginServerContext } from "@getpaseo/plugin/server";
import { makeReadSquads } from "./server/squads";
import { readSquads, screensGate } from "./shared/squads";

export default function contribute(server: PluginServerContext) {
  const gate = server.registerSettings(screensGate);
  server.handle(readSquads, makeReadSquads(gate));
  return () => {};
}
