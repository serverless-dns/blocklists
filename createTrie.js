const fs = require('fs');
const buildTrie = require("./buildTrie.js")
var AWS = require('aws-sdk');
const { Console } = require('console');
var awsBucketName = process.env.AWS_BUCKET_NAME
const s3 = new AWS.S3({
	accessKeyId: process.env.AWS_ACCESS_KEY,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

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
			tag_dict[uname].show = 1
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

		var uploadFileKey = Date.now()

		await buildTrie.build(blocklist, fs, "./result/", tag_dict, basicconfig)
		if (process.env.AWS_ACCESS_KEY != undefined && process.env.AWS_SECRET_ACCESS_KEY != undefined && awsBucketName != undefined) {
			console.log("Uploading file to S3")
			let aw1 = await uploadToS3("./result/td.txt", "completeblocklist/" + uploadFileKey + "/td.txt")
			let aw2 = await uploadToS3("./result/rd.txt", "completeblocklist/" + uploadFileKey + "/rd.txt")
			let aw3 = await uploadToS3("./result/basicconfig.json", "completeblocklist/" + uploadFileKey + "/basicconfig.json")
			let aw4 = await uploadToS3("./result/filetag.json", "completeblocklist/" + uploadFileKey + "/filetag.json")
			await Promise.all([aw1, aw2, aw3, aw4]);
		}
		else {
			console.log("AWS access key or secret key or bucket name undefined")
			console.log("Files not uploaded to s3")
		}

	}
	catch (e) {
		console.log(e.stack)
		node: process.exit(1)
	}

}


main()

async function uploadToS3(fileName, key) {
	var readstream = fs.createReadStream(fileName)
	console.log("File Uploading To : " + key)
	const params = {
		Bucket: awsBucketName,
		Key: key,
		Body: readstream,
		ACL: 'public-read'
	};
	s3.upload(params, function (s3Err, data) {
		if (s3Err) throw s3Err
		console.log(`File uploaded successfully at ${data.Location}`)
	});
}