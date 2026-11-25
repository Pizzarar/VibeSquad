#!/bin/bash
# usage: runall.sh port tag outdir
P=$1; T=$2; O=$3; mkdir -p $O
LONGP='Main Game Project Overworld Remaster'; XLP='Main Game Project Overworld Remaster Definitive Edition Collection'; LONGL='Main Game Overworld Quests And Dialogue'; XLL='Main Game Overworld Quests And Dialogue And Side Content Pass'
mk(){ printf '[["Main Game Project","PRJ__X"],["Main Game","%s"],["PRJ__X","%s"]]' "$1" "$2"; }
declare -A RW=( [stock]='[]' [long]="$(mk "$LONGL" "$LONGP")" [xl]="$(mk "$LONGL" "$XLP")" [longlane]="$(mk "$LONGL" "Main Game Project")" [xllane]="$(mk "$XLL" "Main Game Project")" [shortlane]="$(mk "UI" "$XLP")" )
for th in dark light; do for vp in "1280 900" "1920 1080" "3200 1800"; do set -- $vp; for pass in stock long xl longlane xllane shortlane; do
  n=$T-$th-$1-$pass; TMPDIR=~/pwtmp node dump.mjs $P $1 $2 $th '?demo=1&riff=1' "${RW[$pass]}" $O/$n.png > $O/$n.json 2>&1
done; done; done
