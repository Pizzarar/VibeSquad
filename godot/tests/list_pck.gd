extends SceneTree
## Lists file paths in a .pck (format v2/v3): godot --headless --path godot -s tests/list_pck.gd -- <pack.pck>
## Prints one path per line, then "COUNT total=N vs_playtest=M".

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var f := FileAccess.open(args[0], FileAccess.READ) if not args.is_empty() else null
	if f == null:
		print("usage: -s tests/list_pck.gd -- <pack.pck> (cannot open)")
		quit(2)
		return
	if f.get_32() != 0x43504447: # "GDPC"
		print("not a pck")
		quit(2)
		return
	var version := f.get_32()
	f.get_32(); f.get_32(); f.get_32() # engine major/minor/patch
	f.get_32() # pack flags
	f.get_64() # file base
	var dir_offset := f.get_64() if version >= 3 else 0
	if version >= 3:
		f.seek(dir_offset)
	else:
		f.seek(f.get_position() + 16 * 4)
	var count := f.get_32()
	var n := 0
	for i in count:
		var plen := f.get_32()
		var path := f.get_buffer(plen).get_string_from_utf8()
		f.get_64(); f.get_64(); f.get_buffer(16); f.get_32()
		print(path)
		if "vs_playtest" in path: n += 1
	print("COUNT total=%d vs_playtest=%d" % [count, n])
	quit(0)
