extends RefCounted
## Finds the node under a viewport point: Control (topmost visible), then 2D physics, 2D sprites, then 3D raycast.
## Skipped: our own layers (group "vs_playtest_ui"), hidden CanvasLayers, nested Viewports/Windows (other coordinate spaces).

const UI_GROUP := "vs_playtest_ui"


static func pick(tree: SceneTree, point: Vector2) -> Node:
	return pick_in(tree.root, point)


static func pick_in(root: Window, point: Vector2) -> Node:
	var c := _pick_control(root, root, point)
	if c != null:
		return c
	var n := _pick_2d_physics(root, point)
	if n != null:
		return n
	n = _pick_2d_sprite(root, point)
	if n != null:
		return n
	return _pick_3d(root, point)


## True for subtrees that must not be searched.
static func _skip(node: Node, root: Node) -> bool:
	if node.is_in_group(UI_GROUP):
		return true
	if node is CanvasLayer and not (node as CanvasLayer).visible:
		return true
	if node is CanvasItem and not (node as CanvasItem).visible:
		return true
	if node != root and node is Viewport:
		return true # SubViewport / Window: its children live in another coordinate space
	return false


static func _pick_control(node: Node, root: Node, point: Vector2) -> Control:
	if _skip(node, root):
		return null
	# later children draw on top: search them first
	for i in range(node.get_child_count() - 1, -1, -1):
		var hit := _pick_control(node.get_child(i), root, point)
		if hit != null:
			return hit
	if node is Control:
		var ctl := node as Control
		if ctl.mouse_filter != Control.MOUSE_FILTER_IGNORE and ctl.is_visible_in_tree():
			var local := ctl.get_global_transform_with_canvas().affine_inverse() * point
			if Rect2(Vector2.ZERO, ctl.size).has_point(local):
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
	var best: Node2D = null
	for h: Dictionary in world.direct_space_state.intersect_point(q, 16):
		var col: Object = h.get("collider")
		if col is Node2D and (col as Node2D).is_visible_in_tree() and not _in_skipped(col as Node, vp):
			if best == null or (col as Node2D).z_index >= best.z_index:
				best = col as Node2D
	return best


static func _in_skipped(node: Node, root: Node) -> bool:
	var n: Node = node
	while n != null and n != root:
		if _skip(n, root):
			return true
		n = n.get_parent()
	return false


## Topmost visible Sprite2D under the point: highest z_index, then latest in tree order (drawn last).
static func _pick_2d_sprite(vp: Window, point: Vector2) -> Node:
	var world_pt := vp.get_canvas_transform().affine_inverse() * point
	var best: Array = [null] # [Sprite2D]
	_scan_sprites(vp, vp, world_pt, best)
	return best[0]


static func _scan_sprites(node: Node, root: Node, world_pt: Vector2, best: Array) -> void:
	if _skip(node, root):
		return
	if node is Sprite2D and (node as Sprite2D).is_visible_in_tree():
		var s := node as Sprite2D
		if s.get_rect().has_point(s.to_local(world_pt)) and (best[0] == null or s.z_index >= (best[0] as Sprite2D).z_index):
			best[0] = s # pre-order walk: a later hit at the same z is drawn on top
	for c in node.get_children():
		_scan_sprites(c, root, world_pt, best)


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
