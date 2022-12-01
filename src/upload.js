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
import * as zlib from "zlib";
import { genVersion, genVersion7 } from "./ver.js";

// github.com/aws/aws-sdk-js/issues/1766
const AWS = awscjs.default;

// disable compress binaries until there's clarity
// just on how cloudflare transcodes binary content
const compressBinaries = false;

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
const epochSec = num(process.env.UNIX_EPOCH_SEC);
const version = genVersion(epochSec);
const version7 = genVersion7(epochSec);

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

function s3path(x, p = version) {
  return s3dir + "/" + p + "/" + codec + "/" + (empty(x) ? "" : x);
}

function r2path(x, p = version) {
  return r2dir + "/" + p + "/" + codec + "/" + (empty(x) ? "" : x);
}

function localpath(x) {
  return empty(x)
    ? path.normalize(path.join(cwd, outdir))
    : path.normalize(path.join(cwd, outdir, x));
}

function contentType(fname) {
  if (fname.endsWith(".gz")) return "application/gzip";
  else if (fname.endsWith(".json")) return "application/json";
  // treat everything else as octet-stream
  // else if (fname.endsWith(".txt")) return "text/plain";
  else return "application/octet-stream";
}

/**

 * @param {string} key
 * @returns {string}
 */
function filename(key) {
  const i = key.lastIndexOf("/");
  const x = key.substring(i + 1);
  if (x === "rd.txt") {
    return "rank.bin";
  } else if (x === "td.txt") {
    return "trie.bin";
  } else if (x.indexOf("td") >= 0) {
    return x.split(".")[0] + ".bin";
  } else {
    return x;
  }
}

// td is split into 30M parts:
// td00.txt, td01.txt, ... , td99.txt, td100.txt, td101.txt, ...
// ref: github.com/serverless-dns/src/trie.js#splitAndSaveTd
// Uploads all files in localpath() to s3path() / r2path()
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

// Uploads basic-config to a weekly-indexed dir which is of form
// mm-ord; where mm is month => 1 to 12 and ord is (day % 7) => 1 to 5.
// That is, if version is 8 Nov, then version7 is 11-2
async function upload7() {
  const bcjson = "basicconfig.json";
  const fp = localpath(bcjson);
  const fst = await fs.promises.stat(fp);

  if (!fst.isFile()) {
    throw new Error("no basiconfig at: " + fp);
  }

  if (useS3) return toS3(fp, s3path(bcjson, version7));
  else return toR2(fp, r2path(bcjson, version7));
}

async function toS3(f, key) {
  const fin = fs.createReadStream(f);
  const r = {
    "Bucket": s3bucket,
    "Key": key,
    "Body": fin,
    "ACL": "public-read",
    "Content-Type": contentType(key),
    "ChecksumAlgorithm": "sha1",
  };
  log.i("s3: uploading", f, "to", key);
  return s3.upload(r).promise();
}

// the uploads to R2 may be compressed with gz
// though, the downside is that range requests
// are not supported: archive.is/EX0Gd
// community.cloudflare.com/t/234756
// But: we mitigate this by using ~30M splits
// for our largest files: td.txt
async function toR2(f, key) {
  // f as buffer stackoverflow.com/a/70952762
  const fin = fs.readFileSync(f);

  const fname = filename(key);
  const ftype = contentType(key);
  let body = fin;
  let fenc = "";
  if (compressBinaries && ftype.endsWith("octet-stream")) {
    // stackoverflow.com/a/59154603
    // compress with gzip
    body = zlib.gzipSync(fin);
    // brotli is not supported by Web API DecompressionStream
    // which dl.rethinkdns uses to stream uncompressed data out
    fenc = "gzip";
  } else if (ftype.endsWith("gzip")) {
    fenc = "gzip";
  }
  const a = fin.byteLength;
  const b = body.byteLength;
  // eslint-disable-next-line max-len
  // see: docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
  const r = {
    Bucket: r2bucket,
    Key: key,
    Body: body,
    ContentType: ftype,
    // eslint-disable-next-line quotes
    ContentDisposition: 'attachment; filename="' + fname + '"',
    ContentEncoding: fenc,
    // only supported with Workers API
    // eslint-disable-next-line max-len
    // developers.cloudflare.com/r2/data-access/workers-api/workers-api-reference/#checksums
    // ChecksumAlgorithm: "sha1",
    // TODO: basicconfig as metadata?
    // docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html
  };
  log.i("r2:", fname, "to", key, "as", ftype, "sz:raw/gz", a, b);
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

    // exec upload always before upload7, since metadata in
    // upload7 dir is where the downloaders look first
    const ans = await upload();
    const ans7 = await upload7();

    log.i("finished", ans, ans7);
  } catch (e) {
    log.e(e);
    process.exitCode = 1;
  }
}

(async function () {
  await start();
})();
