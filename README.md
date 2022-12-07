A collection of DNS-based blocklists that can be set at [rethinkdns/configure](https://rethinkdns.com/configure) for use with any DNS over HTTPS or DNS over TLS client, like the [RethinkDNS + Firewall](https://github.com/celzero/rethink-app/) app for Android. As of Dec 2022, 194 blocklists are ingested with ~13.5 million domain names.

### Add a new blocklist
Fork and edit [config.json](https://github.dev/serverless-dns/rethink-blocklist-metadata/blob/main/config.json). Then, add a new entry (if not already present) at the **bottom** of the json file, as its *last* entry:

```json
    {
      "vname": "Combined Privacy Block Lists: Light (bongochong)",

      "group": "Privacy",
      "subg": "CPBL",

      "format": "wildcard",
      "url": "https://raw.githubusercontent.com/bongochong/CombinedPrivacyBlockLists/master/MiniLists/NoFormatting/mini-cpbl-wildcard-blacklist.txt",

      "pack": ["liteprivacy", "recommended"],
      "level": [0, 0]
    }
```
where,
1. Name
    i. `vname`
        - a string, human-readable name of the blocklist.
        - may be empty, but preferably not.
2. Qualifiers
    i. `group`
        - a non-empty string, buckets blocklists into a group.
        - current in-use groups are: `Privacy`, `Security`, `ParentalControl`.
    ii. `subg`
        - a string, usually the blocklist project itself (like `1Hosts`, `RPi`, `StevenBlack` etc).
        - may be empty.
3. Files
    i. `format`
        - a non-empty string or a list of strings, identifies the file-format of blocklists (as defined in the `url` field).
        - supported file-formats: [`domains`](https://raw.githubusercontent.com/Spam404/lists/master/main-blacklist.txt),
          [`hosts`](https://raw.githubusercontent.com/Sinfonietta/hostfiles/master/gambling-hosts),
          [`abp`](https://stanev.org/abp/adblock_bg.txt),
          [`wildcards`](https://raw.githubusercontent.com/bongochong/CombinedPrivacyBlockLists/master/MiniLists/NoFormatting/mini-cpbl-wildcard-blacklist.txt).
    ii. `url`
        - a non-empty string or a list of strings, points to urls where the blocklists exists.
        - should be a well-formed http url; example: `https://fanboy.co.nz/r/fanboy-ultimate.txt`,
          or a list of well-formed http urls `["https://url1...", "https://url2..."]
4. Characteristics
    i. `pack`
        - an array of strings, tags the blocklists into an overarching category.
        - some of the categories are `spam`, `spyware`, `malware`, `scams & phising`, `adult`, `drugs`, `gambling`,
          `social-media`, `smart-tv`, `games`, `shopping`, `dating`, `vanity`, `facebook`, `google`, `amazon`,
          `vpn & proxies`, `url-shorteners`, `privacy` etc.
        - may be empty.
    ii. `level`
        - an array of numbers, one per pack.
        - denotes an arbitrary calibration of the severity of the blocklist for a given pack, that is (`0` for
          *lite*, `1` for *aggressive*, `2` for *extreme*); for example, `NSO + others (Amnesty)` blocklist
          for `Security` is `2` (*extreme*) on `spyware` blocks, but `0` (*lite*) on  `privacy` blocks.
        - empty only if `pack` is empty.

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
