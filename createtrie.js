const fs = require('fs');
const readline = require('readline');
const buildTrie = require("./Buildtrie.js")
const useTrie = require("./UseTrie.js")
const BloomFilter = require("./BloomFilter.js")
let blocklist = []
var tag_dict = {}
var rflags = []
var wholedata = {}
let setdomain = new Set()
var bloomobj;
var basicconfig = {};
const atob = a => Buffer.from(a, 'base64').toString('binary')
const btoa = b => Buffer.from(b).toString('base64')
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

async function parsefile() {
	try {
		let linecount = 0
		let foundcount = 0
		let filecount = 0
		var Starttime
		var Difftime
		var TotalTime = 0
		var timearr = []
		for (filepath of blocklist) {
			filecount++
			var fileData = fs.readFileSync(filepath, { encoding: 'utf8', flag: 'r' });
			console.log("Searching : " + filepath)
			if (fileData.length > 1) {
				let line
				let ts
				let serresult
				for (line of fileData.split("\n")) {
					line = line.trim()
					ts = useTrie.TxtEnc.encode(line).reverse()
					Starttime = new Date().getTime()
					serresult = useTrie.TrieObj.ft.lookup(ts)
					Difftime = (new Date().getTime()) - Starttime
					timearr.push(Difftime)
					TotalTime = TotalTime + Difftime
					if (serresult) {
						foundcount++
					}
					linecount++
				}
			}
			else {
				console.log("File Is Empty : " + filepath)
			}
			//break
		}
		console.log("File Count : " + filecount)
		console.log("Line Count : " + linecount)
		console.log("found Line : " + foundcount)
		console.log("Diff : " + (linecount - foundcount))
		console.log("Total time for search : " + TotalTime)
		printtime(timearr)
	}
	catch (e) {
		console.log(e)
		throw e
	}
}

function printtime(arr) {
	arr.sort(function (a, b) { return a - b })
	var len = arr.length - 1
	console.log("1 : " + arr[0])
	console.log("5 : " + arr[parseInt((len * 5) / 100)])
	console.log("10 : " + arr[parseInt((len * 10) / 100)])
	console.log("25 : " + arr[parseInt((len * 25) / 100)])
	console.log("50 : " + arr[parseInt((len * 50) / 100)])
	console.log("75 : " + arr[parseInt((len * 75) / 100)])
	console.log("80 : " + arr[parseInt((len * 80) / 100)])
	console.log("90 : " + arr[parseInt((len * 90) / 100)])
	console.log("95 : " + arr[parseInt((len * 95) / 100)])
	console.log("98 : " + arr[parseInt((len * 98) / 100)])
	console.log("99 : " + arr[parseInt((len * 99) / 100)])
	console.log("99.1 : " + arr[parseInt((len * 99.1) / 100)])
	console.log("99.2 : " + arr[parseInt((len * 99.2) / 100)])
	console.log("99.3 : " + arr[parseInt((len * 99.3) / 100)])
	console.log("99.4 : " + arr[parseInt((len * 99.4) / 100)])
	console.log("99.5 : " + arr[parseInt((len * 99.5) / 100)])
	console.log("99.6 : " + arr[parseInt((len * 99.6) / 100)])
	console.log("99.7 : " + arr[parseInt((len * 99.7) / 100)])
	console.log("99.8 : " + arr[parseInt((len * 99.8) / 100)])
	console.log("99.9 : " + arr[parseInt((len * 99.9) / 100)])
	console.log("100 : " + arr[parseInt((len * 100) / 100)])
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

async function loadTrie() {
	try {
		var arr = []
		var td_buf = new Uint16Array((fs.readFileSync("./result/td.txt")).buffer);
		var rd_buf = new Uint16Array((fs.readFileSync("./result/rd.txt")).buffer);
		useTrie.build(td_buf, rd_buf, tag_dict, basicconfig)
		useTrie.TrieObj.ft = useTrie.getft()
		useTrie.TrieObj.t = useTrie.gett()


		let ts = useTrie.TxtEnc.encode("www.beead.it").reverse()
		let serresult = useTrie.TrieObj.ft.lookup(ts)
		console.log(serresult)
		if (serresult) {
			let converted
			for (let [key, value] of serresult) {
				converted = useTrie.TrieObj.t.flagsToTag(value)
				console.log(converted)
			}

		}
		else {
			console.log("word not found in trie")
		}
	}
	catch (e) {
		console.log(e)
		throw e
	}
}


async function testloadbloom() {
	var intarr = new Int32Array((fs.readFileSync("./result/bloom_buckets.txt")).buffer)
	console.log(basicconfig)
	bloomobj.LoadFrmFile(basicconfig.bloom_locations, intarr, basicconfig.bloom_k, basicconfig.bloom_m)
	//console.log(bloomobj)
	console.log(bloomobj.test("sg-ssl.effectivemeasure.net"));
	console.log(bloomobj.test("staging.connatix.com"));
	console.log(bloomobj.test("ads.redlightcenter.com"));
	console.log(bloomobj.test("oascentral.chicagobusiness.com"));
	console.log(bloomobj.test("simpsonitos.com"));
	console.log(bloomobj.test("celzero.fyi"));
}

async function testAdd(fl) {
	var res = useTrie.CHR16(0)
	initialize()
	//console.log(tag_dict)
	for (var flag in fl) {
		var val = tag_dict[fl[flag]].value
		const header = 0;
		const index = ((val / 16) | 0) // + 1;
		const pos = val % 16;
		//console.log("Value : "+val+" Flag : "+fl[flag])
		console.log(tag_dict[fl[flag]])
		let h = 0
		//if(res.length >= 1){
		h = useTrie.DEC16(res[header]);
		//}

		console.log("Mask Bottom : " + MaskBottom[16][16 - index])
		console.log("h start : " + h + " countbit : " + countSetBits(h & MaskBottom[16][16 - index]))
		let dataIndex = countSetBits(h & MaskBottom[16][16 - index]) + 1;
		var n = (((h >>> (15 - (index))) & 0x1) !== 1) ? 0 : useTrie.DEC16(res[dataIndex]);
		const upsertData = (n !== 0)
		h |= 1 << (15 - index);
		n |= 1 << (15 - pos);
		res = useTrie.CHR16(h) + res.slice(1, dataIndex) + useTrie.CHR16(n) + res.slice(upsertData ? (dataIndex + 1) : dataIndex);
		console.log("h : " + h)
		console.log("n : " + n)
		console.log("dataindex : " + dataIndex)
		console.log("index : " + index)
		console.log("Pos : " + pos)
		display(res)
	}
	console.log(res)
}

MaskBottom = {
	16: [0xffff,
		0xfffe,
		0xfffc,
		0xfff8,
		0xfff0,
		0xffe0,
		0xffc0,
		0xff80,
		0xff00,
		0xfe00,
		0xfc00,
		0xf800,
		0xf000,
		0xe000,
		0xc000,
		0x8000,
		0x0000]
};

var BitsSetTable256 = [];
function initialize() {
	BitsSetTable256[0] = 0;
	for (let i = 0; i < 256; i++) {
		BitsSetTable256[i] = (i & 1) + BitsSetTable256[Math.floor(i / 2)];
	}
}

// Function to return the count  
// of set bits in n  
function countSetBits(n) {
	return (BitsSetTable256[n & 0xff] +
		BitsSetTable256[(n >>> 8) & 0xff] +
		BitsSetTable256[(n >>> 16) & 0xff] +
		BitsSetTable256[n >>> 24]);
}

function display(str) {
	var uint = []
	for (var i = 0; i < str.length; i++) {
		uint[i] = useTrie.DEC16(str[i])
	}
	console.log(uint)
}
async function main() {

	await loadConfig("./blocklistconfig.json", "./basicconfig.json");
	bloomobj = new BloomFilter.BloomFilter(basicconfig.bloom_m, basicconfig.bloom_k)
	//testloadbloom()
	await getBlockListFiles('./blocklistfiles/');
	await buildTrie.build(blocklist, fs, "./result/", tag_dict, bloomobj, basicconfig)
	//await loadTrie()
	//console.log(custom_flagtotag(Base64ToUint_v1("YBcgAIAQIAAIAABgIAA=")))
	//await testAdd(["DAH","ADH","BXW", "BQJ"])
	//let buff = Buffer.from("4ZiAEEgQ", 'base64');
	//display(buff.toString('utf-8'))

	//await parsefile();

}


main()

function custom_tagtoflag(fl) {
	var res = useTrie.CHR16(0)
	initialize()
	//console.log(tag_dict)
	for (var flag in fl) {
		var val = tag_dict[fl[flag]].value
		const header = 0;
		const index = ((val / 16) | 0) // + 1;
		const pos = val % 16;
		//console.log("Value : "+val+" Flag : "+fl[flag])
		//console.log(tag_dict[fl[flag]])
		let h = 0
		//if(res.length >= 1){
		h = useTrie.DEC16(res[header]);
		//}

		//console.log("Mask Bottom : "+BitString.MaskBottom[16][16 - index])
		//console.log("h start : "+h+" countbit : "+countSetBits(h & BitString.MaskBottom[16][16 - index]))
		let dataIndex = countSetBits(h & MaskBottom[16][16 - index]) + 1;
		var n = (((h >>> (15 - (index))) & 0x1) !== 1) ? 0 : useTrie.DEC16(res[dataIndex]);
		const upsertData = (n !== 0)
		h |= 1 << (15 - index);
		n |= 1 << (15 - pos);
		res = useTrie.CHR16(h) + res.slice(1, dataIndex) + useTrie.CHR16(n) + res.slice(upsertData ? (dataIndex + 1) : dataIndex);
		//console.log("h : "+h)
		//console.log("n : "+n)
		//console.log("dataindex : "+dataIndex)
		//console.log("index : "+index)
		//console.log("Pos : "+pos)
	}
	//console.log(res)
	//display(res)
	return res
}

function Base64ToUint(flag) {
	str = decodeURIComponent(escape(atob(decodeURIComponent(flag))))
	var uint = []
	for (var i = 0; i < str.length; i++) {
		uint[i] = useTrie.DEC16(str[i])
	}
	return uint
}

function custom_flagtotag(flags) {
	// flags has to be an array of 16-bit integers.
	const header = flags[0];
	const tagIndices = [];
	const values = []
	for (let i = 0, mask = 0x8000; i < 16; i++) {
		if ((header << i) === 0) break;
		if ((header & mask) === mask) {
			tagIndices.push(i);
		}
		mask = mask >>> 1;
	}
	// flags.length must be equal to tagIndices.length
	if (tagIndices.length !== flags.length - 1) {
		console.log(tagIndices, flags, " flags and header mismatch (bug in upsert?)");
		return values;
	}
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i + 1];
		const index = tagIndices[i]
		for (let j = 0, mask = 0x8000; j < 16; j++) {
			if ((flag << j) === 0) break;
			if ((flag & mask) === mask) {
				const pos = (index * 16) + j;
				//console.log("pos " , pos, "index/tagIndices", index, tagIndices, "j/i", j , i);
				values.push(rflags[pos]);
			}
			mask = mask >>> 1;
		}
	}
	return values;
}

function encodeToBinary(s) {
	const codeUnits = new Uint16Array(s.length);
	for (let i = 0; i < codeUnits.length; i++) {
		codeUnits[i] = s.charCodeAt(i);
	}
	return String.fromCharCode(...new Uint8Array(codeUnits.buffer));
}

function Base64ToUint_v1(flag) {
	let str = decodeURI(flag)
	str = decodeFromBinary(atob(str.replace(/_/g, '/').replace(/-/g, '+')))
	var uint = []
	for (var i = 0; i < str.length; i++) {
		uint[i] = useTrie.DEC16(str[i])
	}
	return uint
}

function decodeFromBinary(b) {
	const bytes = new Uint8Array(b.length);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = b.charCodeAt(i);
	}
	return String.fromCharCode(...new Uint16Array(bytes.buffer));
}

async function main_v1(list) {
	var flag = encodeURI(btoa(encodeToBinary(custom_tagtoflag(list))).replace(/\//g, '_').replace(/\+/g, '-'))
	console.log(flag)
	flag = Base64ToUint_v1(flag)
	console.log(custom_flagtotag(flag))
}