/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const AWS = require("aws-sdk")
const fs = require("fs")
const path = require("path")
const log = require("./log.js")

const cwd = "."
const outdir = process.env.OUTDIR

const s3bucket = process.env.AWS_BUCKET_NAME
const s3dir = process.env.S3DIR
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
})

const d = new Date()
// ex: 2022/1664574546478
const version = d.getFullYear() + "/" + d.getTime()

function empty(str) {
    return !str
}

function s3path(x) {
    return s3dir + "/" + version + "/" + (empty(x) ? "" : x)
}

function localpath(x) {
    return (empty(x)) ? path.normalize(path.join(cwd, outdir)) :
            path.normalize(path.join(cwd, outdir, x))
}

// td is split into 20M parts: td00.txt, td01.txt, ... , td99.txt, td100.txt, td101.txt, ...
// github.com/serverless-dns/blocklists/blob/8a6d11734ca/.github/workflows/createUploadBlocklistFilter.yml#L32
// Uploads files in localpath
async function upload() {
    const files = await fs.promises.readdir(localpath())

    const reqs = []
    for (const fname of files) {
        const fp = localpath(fname)
        const fst = await fs.promises.stat(fp)
        if (!fst.isFile()) {
            log.i(fp, "not a file")
            continue
        }

        reqs.push(toS3(fp, s3path(fname)))
    }

    return Promise.all(reqs)
}

async function toS3(f, key) {
    const fin = fs.createReadStream(f)
    const r = {
        Bucket: s3bucket,
        Key: key,
        Body: fin,
        ACL: 'public-read'
    }
    log.i("uploading", f, "to", key)
    return s3.upload(r).promise()
}

async function start() {
    try {
        if (empty(process.env.AWS_ACCESS_KEY) || empty(process.env.AWS_SECRET_ACCESS_KEY)) {
            log.i("access / secret keys not found")
        }
        if (empty(s3bucket) || empty(s3dir) || empty(outdir)) {
            log.i("missing: s3-bucket / s3dir / outdir", s3bucket, s3dir, outdir)
            return
        }

        log.i(s3dir, outdir, "; upload from", localpath(), "to", s3path())

        const ans = await upload()

        log.i("finished", ans)
    } catch (e) {
        log.e(e)
        process.exitCode = 1
    }
}

(async function() {
    await start()
})()
