#! python3
# Copyright (c) 2020 RethinkDNS and its authors.
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import errno
import json
import random
import re
import sys
import urllib.request
from urllib.parse import urlparse
import asyncio
import aiohttp

configFileLocation = os.environ.get("BLCONFIG")

supportedFormats = {"domains", "hosts", "abp", "wildcard"}
keyFormat = {"vname", "format", "group", "subg", "url", "pack", "level", "index"}

configDict = {}
totalUrl = 0
savedUrl = 0

# docs.aiohttp.org/en/stable/client_quickstart.html#aiohttp-client-timeouts
ctimeout = aiohttp.ClientTimeout(total=180, sock_connect=15, sock_read=30)

blocklistfiles = os.environ.get("INDIR")
blocklistDownloadRetry = 3
retryBlocklist = list()

def validFormat(fmt):
    global supportedFormats
    return fmt in supportedFormats

def validConfig():
    global keyFormat
    processedUrls = set()

    index = 0
    regex = re.compile(
        r'^(?:http|ftp)s?://'
        r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z]{2,6}\.?|[A-Z0-9-]{2,}\.?)|'
        r'localhost|'
        r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})'
        r'(?::\d+)?'
        r'(?:/?|[/?]\S+)$', re.IGNORECASE)

    for ent in configDict["conf"]:

        # note down the order of the blocklist
        ent["index"] = index
        index = index + 1

        if "dead" in ent["pack"] or "ignore" in ent["pack"]:
            continue

        if len(ent) != len(keyFormat):
            print(f"Invalid entry {ent}")
            print(f"Must have {keyFormat}")
            return False

        if not keyFormat <= set(ent):
            print(f"Invalid vname {ent}")
            return False

        # url is either a string or a list of strings
        if type(ent["url"]) is str:
            if re.match(regex, ent["url"]) is None:
                print(f"Invalid str(url) in {ent}")
                return False

            if ent["url"] in processedUrls:
                print(f"Dup blocklist {ent}")
                return False
            else:
                processedUrls.add(ent["url"])
        elif type(ent["url"]) is list:
            for u in ent["url"]:
                if re.match(regex, u) is None:
                    print(f"Invalid list(url) in {ent}")
                    return False

                if u in processedUrls:
                    print(f"Dup blocklist {ent}")
                    return False
                else:
                    processedUrls.add(u)
        else:
            print(f"Url must be str or list(str) in {ent}")
            return False

        if type(ent["format"]) is str:
            if not validFormat(ent["format"]):
                print(f"Unsupported str(format) in {ent}")
                return False
        elif type(ent["format"] is list):
            for fmt in ent["format"]:
                if not validFormat(fmt):
                    print(f"Unsupported list(format) in {ent}")
                    return False
        else:
            print(f"Format must be str or list(str) in {ent}")
            return False

        if ent["group"].strip() == "":
            print(f"Missing group {ent}")
            return False

    # shuffle to avoid errors due to rate limiting
    random.shuffle(configDict["conf"])

    return True

def createFileIfNeeded(filename):
    if not os.path.exists(os.path.dirname(filename)):
        try:
            os.makedirs(os.path.dirname(filename))
        except OSError as exc:  # Guard against race condition
            if exc.errno != errno.EEXIST:
                raise


def safeStr(obj):
    try:
        return str(obj)
    except UnicodeEncodeError:
        return obj.encode('ascii', 'ignore').decode('ascii')


def extractDomains(txt, rgx, groupindex):
    domainlist = set()
    regexc = re.compile(rgx, re.M)

    for match in re.finditer(regexc, txt):
        g = match.groups()
        if g is None or len(g) <= groupindex:
            continue
        g2 = g[groupindex]
        g2 = g2.strip()
        if g2 and g2[-1] != '.':
            domainlist.add(g2)

    if len(domainlist) <= 0:
        return ""

    return "\n".join(domainlist)


def writeFile(download_loc_filename, txt):
    global savedUrl
    if txt and len(txt) > 0:
        createFileIfNeeded(download_loc_filename)
        with open(download_loc_filename, "w") as f:
            f.write(safeStr(txt))
            f.close()
        savedUrl = savedUrl + 1
        return True
    else:
        print(f"write: empty txt for ${download_loc_filename}\n")
        return False


def urllibRequestApi(url):
    try:
        response = urllib.request.urlopen(url)
        data = response.read()
        r = data.decode('utf-8')
        return r
    except Exception as e:
        print(e)
        return False


# docs.aiohttp.org/en/stable/
async def requestApi(session, url):
    async with session.get(url) as response:
        if response.status == 200:
            return await response.text()
        else:
            raise (DownloadFailed(
                f"downloading {url} failed; status: {response.status}"))


# stackoverflow.com/a/7957496
class DownloadFailed(Exception):
    def __init__(self, m):
        self.message = m

    def __str__(self):
        return self.message


# realpython.com/async-io-python/
async def downloadFile(sess, urls, formats, packtypes, download_loc_filename):
    global totalUrl
    ret = False
    alldomains = ""

    if ('dead' in packtypes or 'ignore' in packtypes):
        print(f"\n dead / ignore -> skip download {urls}\n")
        return ret

    totalUrl = totalUrl + 1

    if type(urls) is str:
        ul = list()
        ul.append(urls)
        urls = ul

    if type(formats) is str:
        fl = list()
        fl.append(formats)
        formats = fl

    print(f"read: {totalUrl}; src: {urls} | dst: {download_loc_filename}")

    for i in range(0, len(urls)):
        url = urls[i]
        if len(formats) <= i:
            print(f"format missing for {url}")
            continue
        format = formats[i]
        domains = ""
        response = ""
        print(f"\tprocessing {url} of type {format}\n")

        for i in range(0, 2):
            try:
                response = await requestApi(sess, url)
                if len(response) == 0:
                    print(f"\nretry_once: dead-list {url} : {download_loc_filename}\n")
                    continue
                else:
                    break
            except Exception as e:
                print(f"\nretry_once: download err {url} / {e}")
                continue

        if len(response) == 0:
            print(f"dead list: no response {url} : {download_loc_filename}\n")
            continue

        if format == "wildcard":
            domains = extractDomains(response, r'(^[\*\.]+)([a-zA-Z0-9][a-zA-Z0-9-_.]+)', 1)
        elif format == "domains":
            domains = extractDomains(response, r'(^[a-zA-Z0-9][a-zA-Z0-9-_.]+)', 0)
        elif format == "hosts":
            domains = extractDomains(
                response, r'(^([0-9]{1,3}\.){3}[0-9]{1,3})([ \t]+)([a-zA-Z0-9-_.]+)', 3)
        elif format == "abp":
            domains = extractDomains(response,
            r'^(\|\||[a-zA-Z0-9])([a-zA-Z0-9][a-zA-Z0-9-_.]+)((\^[a-zA-Z0-9\-\|\$\.\*]*)|(\$[a-zA-Z0-9\-\|\.])*|(\\[a-zA-Z0-9\-\||\^\.]*))$',
            1)

        dlen = len(domains)
        alen = len(alldomains)
        if (dlen > 0):
            print(f"\t total domains in {url} of type {format}: {dlen}\n")
            if (alen > 0):
                alldomains = alldomains + "\n" + domains
            else:
                alldomains = domains

    alen = len(alldomains)
    print(f"write: {totalUrl}; src: {urls} | dst: {download_loc_filename} | tot: {alen} of ({len(urls)}) urls\n")

    ret = writeFile(download_loc_filename, alldomains)

    if not ret:
        print(f"\nretry: 0 entries {urls} : {download_loc_filename}\n")
        return "retry"

    return ret

async def startDownloads(configList):
    global retryBlocklist
    global blocklistfiles

    downloadLoc = ""
    fileName = ""

    if blocklistfiles is None:
        print(f"env var blocklistfiles is None; not downloading files")
        return

    # realpython.com/python-concurrency/#asyncio-version
    async with aiohttp.ClientSession(timeout=ctimeout) as sess:
        tasks = []
        for value in configList:
            packtypes = value["pack"]
            urls = value["url"]
            fmt = value["format"]
            group = value["group"].strip()
            subg = value["subg"].strip()

            # index is the original order of the blocklist before shuffling
            fileName = str(value["index"]).lower()

            if group == "":
                downloadLoc = "./" + blocklistfiles + "/" + fileName + ".txt"
            elif subg == "":
                downloadLoc = "./" + blocklistfiles + "/" + group + "/" + fileName + ".txt"
            else:
                downloadLoc = "./" + blocklistfiles + "/" + group + "/" + subg + "/" + fileName + ".txt"

            task = asyncio.ensure_future(
                downloadFile(sess, urls, fmt, packtypes, downloadLoc))
            tasks.append(task)

        # docs.python.org/3/library/asyncio-task.html#running-tasks-concurrently
        rets = await asyncio.gather(*tasks, return_exceptions=True)

        for i in range(0, len(rets)):
            ret = rets[i]
            val = configList[i]
            if ret == "retry":
                print (f"\nblocklist download failed:\n{val}\n")
                retryBlocklist.append(val)
            elif not ret:
                print(f"\n\nblocklist ignored:\n{val}\n")
            else:
                # blocklist download & save successful
                pass


def loadBlocklistConfig():
    done = False
    global configDict

    try:
        if configFileLocation is not None and os.path.isfile(configFileLocation):
            with open(configFileLocation) as jsonfile:
                configDict = json.load(jsonfile)
                jsonfile.close()
                if "conf" in configDict:
                    done = True
        if not done:
            configDict["conf"] = {}

    except:
        print("Could not parse config.json")

    return done


def main():
    global totalUrl
    global savedUrl
    global configDict
    global retryBlocklist

    ok = loadBlocklistConfig()

    if not ok:
        print("Error loading config, download aborted.")
        sys.exit("")

    if validConfig():
        asyncio.run(startDownloads(configDict["conf"]))

        print("\nTotal blocklists: " + str(totalUrl))
        print("Saved blocklists: " + str(savedUrl))
        print("Difference: " + str(totalUrl - savedUrl))

        if len(retryBlocklist) > 0:
            print("\n\nretry downloading blocklist\n")
            tmpRetryBlocklist = retryBlocklist
            retryBlocklist = list()
            asyncio.run(startDownloads(tmpRetryBlocklist))

        if len(retryBlocklist) > 0:
            print("\nretries failed for\n")
            for value in retryBlocklist:
                print(f"{value}\n")
    else:
        print("validation Error")
        sys.exit("")


if __name__ == "__main__":
    main()
