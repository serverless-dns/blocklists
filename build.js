const fs = require('fs')
const path = require('path')
const trie = require("./trie.js")

async function getBlocklistFiles(path) {
    let blocklists = []
    let dirs = []
    dirs.push(path)
    while (const d = dirs.shift()) {
        const dir = await fs.promises.opendir(d);
        for await (const entry of dir) {
            if (entry.isDirectory()) {
                dirs.push(path.join(d, entry.name))
            } else {
                blocklists.push(d + entry.name)
            }
        }
    }
    return blocklists
}

async function loadConfig(blocklistConfigPath, unameVnameMapPath) {
    try {
        const tags = {}
        const fileData = fs.readFileSync(blocklistConfigPath, 'utf8')
        const mapData = fs.readFileSync(unameVnameMapPath, "utf8")
        const blocklistobj = JSON.parse(fileData);
        const unameVnameMap = JSON.parse(mapData)

        for (let index in blocklistobj.conf) {
            let uname = unameVnameMap[index]
            if (typeof uname == "undefined") {
                uname = index + ""
            }

            tags[uname] = {}
            tags[uname].value = parseInt(index)
            tags[uname].uname = uname
            tags[uname].vname = blocklistobj.conf[index].vname

            tags[uname].group = blocklistobj.conf[index].group
            tags[uname].subg = blocklistobj.conf[index].subg
            tags[uname].url = blocklistobj.conf[index].url
            tags[uname].show = 0
            tags[uname].entries = 0
        }
        return tags
    } catch (e) {
        console.log(e)
        throw e
    }
}

async function main() {
    const outdir = path.normalize("./result/")
    const bldir = path.normaize("./blocklistfiles/")
    const blconfig = path.normalize("./blocklistConfig.json")
    const unamemap = path.normalize("./valueUnameMap.json")

    try {
        const tags = await loadConfig(blconfig, unamemap)
        const bl = await getBlocklistFiles(bldir);
        await trie.build(bl, fs, outdir, tags)
    } catch (e) {
        console.log(e.stack)
        process.exitCode = 1
    }
}

main()
