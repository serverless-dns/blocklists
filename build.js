const fs = require('fs');
const buildTrie = require("./buildTrie.js")


let blocklist = []
var tag_dict = {}
var basicconfig = {};

async function getBlockListFiles(path) {
    let arr = []
    arr.push(path)
    while (data = arr.shift()) {
        const dir = await fs.promises.opendir(data);
        for await (const dirent of dir) {
            if (dirent.isDirectory()) {
                arr.push(data + dirent.name + "/")
            }
            else {
                blocklist.push(data + dirent.name)
            }
        }
    }
}




async function loadConfig(blocklistConfigPath, unameVnameMapPath) {
    try {
        var arr = []
        var fileData = fs.readFileSync(blocklistConfigPath, 'utf8');
        blocklistobj = JSON.parse(fileData);
        var mapData = fs.readFileSync(unameVnameMapPath, "utf8")
        unameVnameMap = JSON.parse(mapData)
        tag_dict = {}
        let uname = ""
        for (let index in blocklistobj.conf) {
            uname = unameVnameMap[index]
            if (uname == undefined) {
                uname = index + ""
            }

            tag_dict[uname] = {}
            tag_dict[uname].value = parseInt(index)
            tag_dict[uname].uname = uname
            tag_dict[uname].vname = blocklistobj.conf[index].vname

            tag_dict[uname].group = blocklistobj.conf[index].group
            tag_dict[uname].subg = blocklistobj.conf[index].subg
            tag_dict[uname].url = blocklistobj.conf[index].url
            tag_dict[uname].show = 0
            tag_dict[uname].entries = 0

        }

        //fs.writeFileSync("./result/filetag.json", JSON.stringify(tag_dict));
    }
    catch (e) {
        console.log(e)
        throw e
    }
}

async function main() {
    try {

        await loadConfig("./blocklistConfig.json", "./valueUnameMap.json");
        await getBlockListFiles('./blocklistfiles/');
        await buildTrie.build(blocklist, fs, "./result/", tag_dict, basicconfig)
    }
    catch (e) {
        console.log(e.stack)
        node: process.exit(1)
    }

}


main()
