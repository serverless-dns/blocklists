This repository is a collection of DNS-based blocklists that can be set at [rethinkdns/configure](https://rethinkdns.com/configure) for use with any DNS over HTTPS client, like the [RethinkDNS + Firewall](https://github.com/celzero/rethink-app/) android app. As of 2021, close to 200 blocklists are supported totaling 5.5 million domain name entries.

**To add a new blocklist** fork and edit [blocklistConfig.json](https://github.com/serverless-dns/rethink-blocklist-metadata/blob/main/blocklistConfig.json), and a new entry which looks like this:

```json
    {
        "vname": "OISD (full)",
        "format": "domains",
        "group": "privacy",
        "subg": "rethinkdns-recommended",
        "url": "https://raw.githubusercontent.com/ookangzheng/dbl-oisd-nl/master/dbl.txt"
    }
```
1. `vname`
    * a string, human-readable name of the blocklist.
    * may be empty, but preferably not.
2. `format`
    * a non-empty string, identifies a particular blocklist file-format.
    * supported file-formats: [`domains`](https://raw.githubusercontent.com/Spam404/lists/master/main-blacklist.txt), [`hosts`](https://raw.githubusercontent.com/Sinfonietta/hostfiles/master/gambling-hosts), [`abp`](https://stanev.org/abp/adblock_bg.txt).
3. `group`
    * a non-empty string, buckets blocklists into a group.
    * current in-use groups are: `privacy`, `security`, `parentalcontrol`.
4. `subg`
    * a string, further buckets blocklists into a sub-group within a group.
    * examples of some sub-groups: `gambling`, `dating`, `piracy`, `porn`, `social-networks`, `affiliate-tracking-domain`, `threat-intelligence-feeds`.
    * may be empty, but preferably not.

5. `url`
    * a non-empty string, points to a url where the blocklist exists.
    * should be a well-formed http url; example: `https://fanboy.co.nz/r/fanboy-ultimate.txt`.

Submit a pull-request of your fork to have it considered for an inclusion in the *default* RethinkDNS implementation of both [the client](https://rethinkfirewall.com/) and [the resolver](https://rethinkdns.com/).

### Development
If you're a developer looking to experiment with the code-base or generate your own compressed blocklist, read on.

1. Download blocklist files.
    ```python
        # this python-script parses `blocklistConfig.json` and downloads corresponding
        # blocklists in to `./blocklistfiles` directory.
        python3 download.py
    ```
2. Create and upload to S3; a compressed, compact radix-trie of domains present in downloaded blocklists.
    ```shell
        # this nodejs script parses downloaded files in the ./blocklistfiles directory to create
        # a compressed, compact radix-trie and related files in the ./result directory.
        node --max-old-space-size=12288 build.js
    ```
3. Upload to S3
    ```shell
        # set aws environment variables for ubuntu/mac, like so:
        export AWS_ACCESS_KEY = "access-key with s3 permissions"
        export AWS_SECRET_ACCESS_KEY = "secret-key with s3 permissions"
        export AWS_BUCKET_NAME = "s3 bucket-name to upload the files to"
        # environment variable for windows like so:
        set AWS_ACCESS_KEY = "aws access key to acccess s3"
        set AWS_SECRET_ACCESS_KEY = "aws secret key to access s3"
        set AWS_BUCKET_NAME = "aws bucket name where files to be uploaded"
        # installs the aws-sdk for nodejs
        npm install aws-sdk
        # this nodejs script uploads compact radix-trie files in ./result directory to the specified S3 bucket.
        node upload.js
    ```

