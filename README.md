## About Rethink Dns Blocklist Metadata

This contains [blocklistconfi.json](https://github.com/serverless-dns/rethink-blocklist-metadata/blob/main/blocklistconfig.json) file, which contains information about list of blocklist file and its path, name, file format, grouping details.
Currently the above file contains information about 171 blocklists, which is used to create blocklist dump with 5.5 million entries.

## Rethink Dns Blocklist Metadata Format

```json
    {    
      "value": 170,
      "vname": "oisd(full)",
      "uname": "FHM",
      "format": "domains",
      "group": "privacy",
      "subg": "",
      "url": "https://raw.githubusercontent.com/ookangzheng/dbl-oisd-nl/master/dbl.txt"
    }
```
* value
```
value is a integer field which uniquely identifies blocklist.
value is unique.
value cannot be greater than 255, this is current limitation.
```
* vname
```
vname is a string field which is used to denote blocklist with readable name in website and app.
vname can be empty
```
* uname
```
uname is a string field which is used to uniquely identify blocklist during dump creation and search.
uname field cannot be empty.
uname should contian 3 uppercase alpha character[A-Z].
```

* format
```r
format is a string field which is used to identify particular blocklist file format for parsing.
currently supported file formats are ['domains', 'hosts', 'abp']
format field cannot be empty.
format field can be one of three supported formats.
[abp (Adblock plus) format example](https://stanev.org/abp/adblock_bg.txt)
[domains format example](https://raw.githubusercontent.com/Spam404/lists/master/main-blacklist.txt)
[hosts format example](https://raw.githubusercontent.com/Sinfonietta/hostfiles/master/gambling-hosts)
```

* group
```
group is a string field and is used to cluster blocklist files at first level.
group field cannot be empty.
To identify group visit [configure page](https://rethinkdns.com/configure)
```

* subg
```
subg is a string field and it denote sub group.
subg field is used to cluster blocklist files at second field.
subg field can be empty.
```
* url
```
url is a string field and it denote location from where blocklist file exits.
url field cannot be empty.
url field should be in proper url format
```

## Add Blocklist To File
To add your blocklist file to Rethink Dns dump.
Create proper json structure as below
```
    {    
      "value": 180, #Should be unique in the File. Provide the value in incremental, eg if last blocklist value is 179, then your value should be 180
      "vname": "oisd(full)", #Name to represent in website
      "uname": "FHM", #Should be unique in the File
      "format": "domains", #Should be in one of format ['domains', 'hosts', 'abp']
      "group": "privacy", #To identify the blocklist group check our site
      "subg": "",#To identify the blocklist group check our site
      "url": "https://raw.githubusercontent.com/ookangzheng/dbl-oisd-nl/master/dbl.txt" #Should be in proper url format that points to the file
    }
```
After creating proper structure, add it to end of json file and create pull request.

