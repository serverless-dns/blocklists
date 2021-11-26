const AWS = require("aws-sdk")
const fs = require("fs")
const path = require("path")

const cwd = "."
const outdir = "result"

const s3bucket = process.env.AWS_BUCKET_NAME
const s3dir = "blocklists"
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
})

const version = Date.now()

function empty(str) {
    return !str
}

function s3path(x) {
    return s3dir + "/" + version + "/" + (empty(x)) ? "" : x
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
            console.log(fp, "not a file")
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
    console.log("uploading", f, "to", key)
    return s3.upload(r).promise()
}

(async function() {
    try {
        if (empty(process.env.AWS_ACCESS_KEY) ||
                    empty(process.env.AWS_SECRET_ACCESS_KEY) ||
                    empty(process.env.AWS_BUCKET_NAME)) {
            console.log("one/all of access-key, secret-key, s3-bucket missing")
            return
	    }

        console.log("upload from", localpath(), "to", s3path())

	    const ans = await upload()

        console.log("finished", ans)
    } catch (e) {
        console.log(e)
        process.exitCode = 1
    }
})()
