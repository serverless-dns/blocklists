#!/bin/bash -eux

# stackoverflow.com/a/16753536
if [ -n "${FLY_REGION+x}" ] && [ ! -e "/swapfile" ]; then
  # make swap: community.fly.io/t/6782/10
  fallocate -l 8192M /swapfile
  chown root:root /swapfile
  mkswap /swapfile
  echo "20" > /proc/sys/vm/swappiness
  swapon /swapfile
fi

# stackoverflow.com/a/28085062
: "${INDIR:=blocklistfiles}"
: "${OUTDIR:=result2}"
: "${S3DIR:=blocklists}"
: "${BLCONFIG:=blocklistConfig.json}"

export INDIR="$INDIR"
export OUTDIR="$OUTDIR"
export S3DIR="$S3DIR"

python ./download.py

# --max-old-space-size=32768 (32G)
node --max-old-space-size=32768 --expose-gc ./build.js

# creates td00.txt, td01.txt, ... , td98.txt, td99.txt, td100.txt, ...
cd "$OUTDIR" && split -b20000000 -d --additional-suffix=.txt td.txt td
# list split files
ls -lhtr

cd - && node ./upload.js
