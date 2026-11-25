// Registry kind: Enemy (v1).
// Bosses are enemies with data.boss = true.
export default { kind: "enemy", label: "Enemy", order: 30, reserved: false, lane: "storybook", required: ["boss"], character: true, slots: ["text", "sprite", "audio"] };
