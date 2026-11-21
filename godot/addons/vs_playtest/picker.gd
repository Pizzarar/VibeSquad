extends RefCounted
## Finds the node under a viewport point: Control (topmost visible), then 2D physics, 2D sprites, then 3D raycast.
## Our own layers (group "vs_playtest_ui") are skipped.

const UI_GROUP := "vs_playtest_ui"


static func pick(tree: SceneTree, point: Vector2) -> Node:
	var vp := tree.root
	var c := _pick_control(vp, point)
	if c != null:
		return c
	var n := _pick_2d_physics(vp, point)
	if n != null:
		return n
	n = _pick_2d_sprite(vp, point)
	if n != null:
		return n
	return _pick_3d(vp, point)


static func _pick_control(node: Node, point: Vector2) -> Control:
	if node.is_in_group(UI_GROUP):
		return null
	if node is CanvasItem and not (node as CanvasItem).visible:
		return null
	# later children draw on top: search them first
	for i in range(node.get_child_count() - 1, -1, -1):
		var hit := _pick_control(node.get_child(i), point)
		if hit != null:
			return hit
	if node is Control:
		var ctl := node as Control
		if ctl.mouse_filter != Control.MOUSE_FILTER_IGNORE and ctl.get_global_rect().has_point(point):
			return ctl
	return null


static func _pick_2d_physics(vp: Window, point: Vector2) -> Node:
	var world := vp.world_2d
	if world == null:
		return null
	var q := PhysicsPointQueryParameters2D.new()
	q.position = vp.get_canvas_transform().affine_inverse() * point
	q.collide_with_areas = true
	q.collide_with_bodies = true
	var hits := world.direct_space_state.intersect_point(q, 8)
	var best: Node = null
	for h: Dictionary in hits:
		var col: Object = h.get("collider")
		if col is Node2D and (best == null or (col as Node2D).z_index >= (best as Node2D).z_index):
			best = col as Node
	return best


static func _pick_2d_sprite(vp: Window, point: Vector2) -> Node:
	var world_pt := vp.get_canvas_transform().affine_inverse() * point
	var best: Node = null
	var stack: Array[Node] = [vp]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n.is_in_group(UI_GROUP):
			continue
		for c in n.get_children():
			stack.append(c)
		if n is Sprite2D and (n as Sprite2D).is_visible_in_tree():
			var s := n as Sprite2D
			if s.get_rect().has_point(s.to_local(world_pt)):
				best = s # later in traversal ~ drawn later; good enough for a fallback
	return best


static func _pick_3d(vp: Window, point: Vector2) -> Node:
	var cam := vp.get_camera_3d()
	var world := vp.world_3d
	if cam == null or world == null:
		return null
	var from := cam.project_ray_origin(point)
	var to := from + cam.project_ray_normal(point) * 1000.0
	var q := PhysicsRayQueryParameters3D.create(from, to)
	q.collide_with_areas = true
	var hit := world.direct_space_state.intersect_ray(q)
	var col: Object = hit.get("collider") if not hit.is_empty() else null
	return col as Node
