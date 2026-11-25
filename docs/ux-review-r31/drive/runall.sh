#!/bin/bash
# usage: runall.sh <port> <outdir>
P=$1; O=$2; mkdir -p $O
export TMPDIR=~/pwtmp
for t in dark light; do
  for s in stuck stuck2 trail3 edge r4 sbkbd; do node $s.mjs $P 1920 1080 1 $t $O > $O/$s-$t.log 2>&1; done
  for m in go2 pw2 slow2 gap0; do node fwdmixed.mjs $P 1920 1080 1 $t $O $m > $O/fwdmixed-$m-$t.log 2>&1; done
  node noinput.mjs $P 1920 1080 $t $O > $O/noinput-$t.log 2>&1
  node matrix.mjs $P m1920 1920 1080 1 $t $O > $O/matrix-$t.log 2>&1
done
