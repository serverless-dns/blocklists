const fs = require('fs');
const buildTrie = require("./Buildtrie.js")
const BloomFilter = require("./BloomFilter.js");
var AWS = require('aws-sdk');
const s3 = new AWS.S3({
		accessKeyId: process.env.AWS_ACCESS_KEY,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
	  });

let blocklist = []
var tag_dict = {}
var rflags = []
var bloomobj;
var basicconfig = {};

async function getBlockListFiles(path) {
	let arr = []
	arr.push(path)
	let count = 0
	while (data = arr.shift()) {
		const dir = await fs.promises.opendir(data);
		for await (const dirent of dir) {
			if (dirent.isDirectory()) {
				arr.push(data + dirent.name + "/")
			}
			else {
				blocklist.push(data + dirent.name)
				count++
			}
		}
	}
}




async function loadConfig(bl_path, basicconfig_path) {
	try {
		var arr = []
		var fileData = fs.readFileSync(bl_path, 'utf8');
		blocklistobj = JSON.parse(fileData);
		tag_dict = {}
		for (let filedata in blocklistobj.conf) {

			tag_dict[blocklistobj.conf[filedata].uname] = {}
			tag_dict[blocklistobj.conf[filedata].uname].value = blocklistobj.conf[filedata].value
			tag_dict[blocklistobj.conf[filedata].uname].uname = blocklistobj.conf[filedata].uname
			tag_dict[blocklistobj.conf[filedata].uname].vname = blocklistobj.conf[filedata].vname

			tag_dict[blocklistobj.conf[filedata].uname].group = blocklistobj.conf[filedata].group
			tag_dict[blocklistobj.conf[filedata].uname].subg = blocklistobj.conf[filedata].subg
			tag_dict[blocklistobj.conf[filedata].uname].url = blocklistobj.conf[filedata].url
			tag_dict[blocklistobj.conf[filedata].uname].entries = 0
			rflags[blocklistobj.conf[filedata].value] = blocklistobj.conf[filedata].uname

		}
		fileData = fs.readFileSync(basicconfig_path, 'utf8');
		basicconfig = JSON.parse(fileData)
		//fs.writeFileSync("./result/filetag.json", JSON.stringify(tag_dict));
		//console.log(basicconfig)
	}
	catch (e) {
		console.log(e)
		throw e
	}
}

async function main() {
	try {
				
		await loadConfig("./blocklistconfig.json", "./basicconfig.json");
		bloomobj = new BloomFilter.BloomFilter(basicconfig.bloom_m, basicconfig.bloom_k)
		await getBlockListFiles('./blocklistfiles/');

		var uploadFileKey = Date.now()

		await buildTrie.build(blocklist, fs, "./result/", tag_dict, bloomobj, basicconfig)
		let aw1 = await uploadToS3("./result/td.txt", "completeblocklist/" + uploadFileKey + "/td.txt")
		let aw2 = await uploadToS3("./result/rd.txt", "completeblocklist/" + uploadFileKey + "/rd.txt")
		let aw3 = await uploadToS3("./result/basicconfig.json", "completeblocklist/" + uploadFileKey + "/basicconfig.json")
		let aw4 = await uploadToS3("./result/bloom_buckets.txt", "completeblocklist/" + uploadFileKey + "/bloom_buckets.txt")
		let aw5 = await uploadToS3("./result/filetag.json", "completeblocklist/" + uploadFileKey + "/filetag.json")
		await Promise.all([aw1, aw2, aw3, aw4, aw5]);
	}
	catch (e) {
		console.log(e.stack)
		node:process.exit(1)
	}

}


main()

async function uploadToS3(fileName, key) {
	var readstream = fs.createReadStream(fileName)
	console.log("File Uploading To : " + key)
	const params = {
		Bucket: 'bravepublic',
		Key: key,
		Body: readstream,
		ACL: 'public-read'
	};
	s3.upload(params, function (s3Err, data) {
		if (s3Err) throw s3Err
		console.log(`File uploaded successfully at ${data.Location}`)
	});
}