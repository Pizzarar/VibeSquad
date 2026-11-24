// Registry kind: Text line (v1).
// Any player-facing text line (relations, encouragement, squad, raid story, CSV, long haul).
export default { kind: "line", label: "Text line", order: 110, reserved: false, lane: "storybook", required: ["text", "origin"], slots: ["text", "voice"] };
