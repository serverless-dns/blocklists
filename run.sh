#!/bin/bash -eux

if ! test -e "/swapfile"; then
  # make swap: community.fly.io/t/6782/10
  fallocate -l 8192M /swapfile
  chown root:root /swapfile
  mkswap /swapfile
  echo 25 > /proc/sys/vm/swappiness
  swapon /swapfile
fi

python ./download.py

# --max-old-space-size=32768 (32G)
node --expose-gc ./build.js

# creates td00.txt, td01.txt, ... , td98.txt, td99.txt, td100.txt, ...
cd "$OUTDIR" && split -b20000000 -d --additional-suffix=.txt td.txt td
# list split files
ls -lhtr

node ./upload.js
