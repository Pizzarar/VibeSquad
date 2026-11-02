import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Off by default: while `enabled` is false the RPC returns no VibeSquad data to any client,
// including relay-paired devices (PLAN_PASEO_PARITY.md, Hub Buddy call 2).
export const screensGate = defineSettings({
  id: "screens",
  scope: "host",
  version: 1,
  schema: z.object({ enabled: z.boolean().default(false) }),
});

const lane = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().optional(),
  state: z.string().optional(),
  paths: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});

const team = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  paths: z.array(z.string()),
  lanes: z.array(lane),
});

export type SquadLane = z.infer<typeof lane>;
export type Squad = z.infer<typeof team>;

// Read-only. Takes no input, so it cannot be pointed at another path or host.
export const readSquads = defineRpc({
  name: "squads.read",
  input: z.object({}),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("off") }),
    z.object({ status: z.literal("error"), error: z.string() }),
    z.object({ status: z.literal("ready"), teams: z.array(team) }),
  ]),
});
