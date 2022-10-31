/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as awscjs from "aws-sdk";
import * as fs from "fs";
import * as path from "path";
import * as log from "./log.js";

// github.com/aws/aws-sdk-js/issues/1766
const AWS = awscjs.default;

const s3bucket = process.env.AWS_BUCKET_NAME;
const s3dir = process.env.S3DIR;
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  maxRetries: 2,
});

const cfid = process.env.CF_ACCOUNT_ID || "";
const r2bucket = process.env.AWS_BUCKET_NAME;
const r2dir = process.env.S3DIR;
const r2 = new AWS.S3({
  region: "auto",
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  endpoint: `https://${cfid}.r2.cloudflarestorage.com`,
  maxRetries: 2,
  s3ForcePathStyle: true,
});

const cwd = process.cwd();
const outdir = process.env.OUTDIR;
const codec = process.env.CODEC || "u6";
const useS3 = bool(process.env.PREFER_S3_OVER_R2) || false;
const epochSec = num(process.env.UNIX_EPOCH_SEC) || Date.now() / 1000;
const version = genVersion();

function genVersion() {
  const d = new Date(epochSec * 1000);
  // ex: 2022/1664574546478
  return d.getFullYear() + "/" + d.getTime();
}

function num(str) {
  return parseFloat(str);
}

// stackoverflow.com/a/4594779
function bool(str) {
  if (empty(str)) {
    return false;
  } else if (typeof str == "string") {
    return str.toLowerCase() === "true";
  } else {
    return !!str;
  }
}

function empty(str) {
  return !str;
}

function s3path(x) {
  return s3dir + "/" + version + "/" + codec + "/" + (empty(x) ? "" : x);
}

function r2path(x) {
  return r2dir + "/" + version + "/" + codec + "/" + (empty(x) ? "" : x);
}

function localpath(x) {
  return empty(x)
    ? path.normalize(path.join(cwd, outdir))
    : path.normalize(path.join(cwd, outdir, x));
}

// td is split into 20M parts:
// td00.txt, td01.txt, ... , td99.txt, td100.txt, td101.txt, ...
// github.com/serverless-dns/blocklists:
// .github/workflows/createUploadBlocklistFilter.yml
// Uploads files in localpath
async function upload() {
  const files = await fs.promises.readdir(localpath());

  const reqs = [];
  for (const fname of files) {
    const fp = localpath(fname);
    const fst = await fs.promises.stat(fp);
    if (!fst.isFile()) {
      log.i(fp, "not a file");
      continue;
    }

    if (useS3) reqs.push(toS3(fp, s3path(fname)));
    else reqs.push(toR2(fp, r2path(fname)));
  }

  return Promise.all(reqs);
}

async function toS3(f, key) {
  const fin = fs.createReadStream(f);
  const r = {
    Bucket: s3bucket,
    Key: key,
    Body: fin,
    ACL: "public-read",
    ChecksumAlgorithm: "sha1",
  };
  log.i("s3: uploading", f, "to", key);
  return s3.upload(r).promise();
}

async function toR2(f, key) {
  const fin = fs.createReadStream(f);
  const r = {
    Bucket: r2bucket,
    Key: key,
    Body: fin,
  };
  log.i("r2: uploading", f, "to", key);
  return r2.upload(r).promise();
}

async function start() {
  try {
    if (
      empty(process.env.AWS_ACCESS_KEY) ||
      empty(process.env.AWS_SECRET_ACCESS_KEY)
    ) {
      log.e("access / secret keys not found");
      return;
    }
    if (useS3) {
      if (empty(s3bucket) || empty(s3dir) || empty(outdir)) {
        log.e("missing: s3-bucket / s3dir / outdir", s3bucket, s3dir, outdir);
        return;
      }
      log.i(s3dir, outdir, "; upload", localpath(), "to", s3path());
    } else {
      if (empty(r2bucket) || empty(r2dir) || empty(outdir) || empty(cfid)) {
        log.e("cfid / bucket / r2dir / outdir", cfid, r2bucket, r2dir, outdir);
        return;
      }
      log.i(r2dir, outdir, "; upload", localpath(), "to", r2path());
    }

    const ans = await upload();

    log.i("finished", ans);
  } catch (e) {
    log.e(e);
    process.exitCode = 1;
  }
}

(async function () {
  await start();
})();
