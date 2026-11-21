extends VSPlaytestAdapter
## Minimal adapter for the sample project: one piece of state, a seed, one cheat.

var coins: int = 0


func get_info() -> Dictionary:
	return {"name": "sample", "version": "0.1.0"}


func get_state() -> Dictionary:
	return {"coins": coins, "player": {"pos": Vector2(12, 34)}}


func get_seed() -> String:
	return "sample-seed-42"


func describe_node(node: Node) -> String:
	return "%s (%s)" % [node.name, node.get_class()]


func get_cheats() -> Array[Dictionary]:
	return [{"id": "add_coins", "label": "Add coins", "args": [10]}]


func run_cheat(id: String, args: Array) -> Variant:
	if id == "add_coins":
		coins += int(args[0]) if args.size() > 0 else 10
		return {"coins": coins}
	return {"error": "unknown cheat"}
