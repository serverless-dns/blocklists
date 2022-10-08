/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const fs = require('fs')
const path = require('path')
const trie = require("./trie.js")
const log = require("./log.js")

const outdir = process.env.OUTDIR
const indir = process.env.INDIR

async function getBlocklistFiles(bldir) {
    let blocklists = []
    let dirs = []
    dirs.push(bldir)
    // all files from bldir, incl sub-directories
    while (d = dirs.shift()) {
        const dir = await fs.promises.opendir(d)
        for await (const entry of dir) {
            const x = path.join(d, entry.name)
            if (entry.isDirectory()) {
                dirs.push(x)
            } else {
                blocklists.push(x)
            }
        }
    }
    return blocklists
}

function loadConfig(blocklistConfigPath, unameVnameMapPath) {
    try {
        const tags = {}
        const fileData = fs.readFileSync(blocklistConfigPath, 'utf8')
        const mapData = fs.readFileSync(unameVnameMapPath, "utf8")
        const blocklistobj = JSON.parse(fileData)
        const unameVnameMap = JSON.parse(mapData)

        for (let index in blocklistobj.conf) {
            let uname = unameVnameMap[index]
            if (uname == null) {
                uname = index + ""; // to string
            }
            uname = uname.toLowerCase();

            tags[uname] = {}
            tags[uname].value = parseInt(index)
            tags[uname].uname = uname
            tags[uname].vname = blocklistobj.conf[index].vname

            tags[uname].group = blocklistobj.conf[index].group
            tags[uname].subg = blocklistobj.conf[index].subg
            tags[uname].url = blocklistobj.conf[index].url
            tags[uname].show = 0
            tags[uname].entries = 0
            log.i("btag for " + uname + " index: " + index, tags[uname].group)
        }
        return tags
    } catch (e) {
        log.e(e)
        throw e
    }
}

async function main() {
    const triedir = path.normalize(`./${outdir}/`)
    const bldir = path.normalize(`./${indir}/`)
    const blconfig = path.normalize("./blocklistConfig.json")
    const unamemap = path.normalize("./valueUnameMap.json")

    try {
        const tags = loadConfig(blconfig, unamemap)
        const bl = await getBlocklistFiles(bldir);
        log.i("build, out: " + triedir + ", in: " + bl + ", tags: " + tags)
        await trie.build(bl, fs, triedir, tags)
    } catch (e) {
        log.e(e)
        process.exitCode = 1
    }
}

(async () => {
    await main()
})();