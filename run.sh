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
: "${BLCONFIG:=config.json}"
: "${CODEC:=u6}"
: "${EPSEC:=$(date +%s)}"
# AWS_BUCKET_NAME, AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY, CF_ACCOUNT_ID
# are vended as secrets

export INDIR="$INDIR"
export OUTDIR="$OUTDIR"
export S3DIR="$S3DIR"
export BLCONFIG="$BLCONFIG"
export CODEC="$CODEC"
export UNIX_EPOCH_SEC="$EPSEC"

python ./download.py

# --max-old-space-size=32768 (32G)
node --max-old-space-size=32768 --expose-gc ./src/build.js

node ./src/upload.js

