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

function loadConfig(blocklistConfigPath) {
    try {
        const tags = {}
        const fileData = fs.readFileSync(blocklistConfigPath, 'utf8')
        const blocklistobj = JSON.parse(fileData)

        for (let index in blocklistobj.conf) {
            const uid = index + ""; // string, must be lowercase

            tags[uid] = {}
            tags[uid].value = parseInt(index)
            tags[uid].vname = blocklistobj.conf[index].vname
            tags[uid].group = blocklistobj.conf[index].group
            tags[uid].subg = blocklistobj.conf[index].subg
            tags[uid].url = blocklistobj.conf[index].url
            tags[uid].show = 0
            tags[uid].entries = 0
            log.i("btag for " + uid + " index: " + index, tags[uid].group)
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

    try {
        const tags = loadConfig(blconfig)
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