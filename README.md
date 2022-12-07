A collection of DNS-based blocklists that can be set at [rethinkdns/configure](https://rethinkdns.com/configure) for use with any DNS over HTTPS or DNS over TLS client, like the [RethinkDNS + Firewall](https://github.com/celzero/rethink-app/) app for Android. As of Dec 2022, 194 blocklists are ingested with ~13.5 million domain names.

### Add a new blocklist
Fork and edit [config.json](https://github.dev/serverless-dns/rethink-blocklist-metadata/blob/main/config.json). Then, add a new entry at the **bottom** of the json file, as its *last* entry:

```json
    {
      "vname": "Combined Privacy Block Lists: Light (bongochong)",
      "format": "wildcard",
      "group": "Privacy",
      "subg": "CPBL",
      "url": "https://raw.githubusercontent.com/bongochong/CombinedPrivacyBlockLists/master/MiniLists/NoFormatting/mini-cpbl-wildcard-blacklist.txt",
      "pack": ["liteprivacy", "recommended"],
      "level": [0, 0]
    }
```
where,
1. `vname`
    * a string, human-readable name of the blocklist.
    * may be empty, but preferably not.
2. `format`
    * a non-empty string, identifies a particular blocklist file-format.
    * supported file-formats: [`domains`](https://raw.githubusercontent.com/Spam404/lists/master/main-blacklist.txt), [`hosts`](https://raw.githubusercontent.com/Sinfonietta/hostfiles/master/gambling-hosts), [`abp`](https://stanev.org/abp/adblock_bg.txt), [`wildcards`](https://raw.githubusercontent.com/bongochong/CombinedPrivacyBlockLists/master/MiniLists/NoFormatting/mini-cpbl-wildcard-blacklist.txt).
3. `group`
    * a non-empty string, buckets blocklists into a group.
    * current in-use groups are: `Privacy`, `Security`, `ParentalControl`.
4. `subg`
    * a string, usually the blocklist project itself (like `1Hosts`, `RPi`, `StevenBlack` etc).
    * may be empty.
5. `url`
    * a non-empty string, points to a url where the blocklist exists.
    * should be a well-formed http url; example: `https://fanboy.co.nz/r/fanboy-ultimate.txt`.
6. `pack`
    * an array of strings, tags the blocklists into an overarching category.
    * some of the categories are `spam`, `spyware`, `malware`, `scams & phising`, `adult`, `drugs`, `gambling`,
      `social-media`, `smart-tv`, `games`, `shopping`, `dating`, `vanity`, `facebook`, `google`, `amazon` etc.
    * this array can be left empty.
7. `level`
    * an array of numbers, one per pack
    * denotes the severity of the blocking (`0` for *lite*, `1` for *aggressive*, `2` for *extreme*).
    * empty only if `pack` is empty.

Submit a pull-request of your changes to have it considered for an inclusion in the *default* RethinkDNS implementation of both [the client](https://rethinkfirewall.com/) and [the resolver](https://rethinkdns.com/).

### Development
If you're a developer looking to experiment with the code-base or generate your own compressed blocklist, read on.

1. Download blocklists.
    ```python
        # parses `config.json` and downloads blocklists in to 'blocklistfiles' dir
        pip3 install aiohttp
        python3 download.py
    ```
2. Build a compressed, succinct radix-trie of all domains in downloaded blocklists.
    ```shell
        # parses downloaded files in the ./blocklistfiles directory to create
        # a compressed, compact radix-trie and related files in the ./result directory.
        node --max-old-space-size=16384 ./src/build.js
    ```
3. Upload the radix-trie and associated files to S3 / R2.
    ```shell
        # set aws environment variables for ubuntu/mac, like so:
        export AWS_ACCESS_KEY = "access-key"
        export AWS_SECRET_ACCESS_KEY = "secret-key"
        export AWS_BUCKET_NAME = "bucket-name"
        npm i
        # uploads files in the 'result' dir to S3 / R2.
        node ./src/upload.js
    ```
