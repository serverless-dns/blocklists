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
1. value
    * value is a integer field which uniquely identifies blocklist.
    * value is unique.
    * value cannot be greater than 255, this is current limitation.
2. vname
    1. vname is a string field which is used to denote blocklist with readable name in website and app.
    2. vname can be empty
3. uname
    1. uname is a string field which is used to uniquely identify blocklist during dump creation and search.
    2. uname field cannot be empty.
    3. uname should contian 3 uppercase alpha character[A-Z].

4. format
    1. format is a string field which is used to identify particular blocklist file format for parsing.
    2. currently supported file formats are ['domains', 'hosts', 'abp']
    3. format field cannot be empty.
    4. format field can be one of three supported formats.
    5. [abp (Adblock plus) format example](https://stanev.org/abp/adblock_bg.txt)
    6. [domains format example](https://raw.githubusercontent.com/Spam404/lists/master/main-blacklist.txt)
    7. [hosts format example](https://raw.githubusercontent.com/Sinfonietta/hostfiles/master/gambling-hosts)
  
5. group
    * group is a string field and is used to cluster blocklist files at first level.
    * group field cannot be empty.
    * To identify group visit [configure page](https://rethinkdns.com/configure)

6. subg
    1. subg is a string field and it denote sub group.
    2. subg field is used to cluster blocklist files at second field.
    3. subg field can be empty.

7. url
    * url is a string field and it denote location from where blocklist file exits.
    * url field cannot be empty.
    * url field should be in proper url format

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

