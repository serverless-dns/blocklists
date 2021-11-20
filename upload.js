var AWS = require('aws-sdk');
const fs = require('fs');
var awsBucketName = process.env.AWS_BUCKET_NAME
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

async function upload() {
    try {
        var uploadFileKey = Date.now()
        if (process.env.AWS_ACCESS_KEY != undefined && process.env.AWS_SECRET_ACCESS_KEY != undefined && process.env.AWS_BUCKET_NAME != undefined) {
            console.log("Uploading file to S3")
            let aw1 = uploadToS3("./result/td.txt", "blocklists/" + uploadFileKey + "/td.txt")
            let aw2 = uploadToS3("./result/rd.txt", "blocklists/" + uploadFileKey + "/rd.txt")
            let aw3 = uploadToS3("./result/basicconfig.json", "blocklists/" + uploadFileKey + "/basicconfig.json")
            let aw4 = uploadToS3("./result/filetag.json", "blocklists/" + uploadFileKey + "/filetag.json")
            await Promise.all([aw1, aw2, aw3, aw4]);
        }
        else {
            console.log("AWS access key or secret key or bucket name undefined")
            console.log("Files not uploaded to s3")
        }
    }
    catch(e){
        console.log(e.stack)
		node: process.exit(1)
    }
}

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

upload()