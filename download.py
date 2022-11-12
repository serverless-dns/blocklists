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

supportedFormats = {"domains", "hosts", "abp", "wildcard"}

keyFormat = {"vname", "format", "group", "subg", "url", "pack"}
configFileLocation = os.environ.get("BLCONFIG")
configDict = {}

totalUrl = 0
savedUrl = 0

blocklistfiles = os.environ.get("INDIR")
blocklistDownloadRetry = 3
blocklistNotDownloaded = list()
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
        if len(ent) != len(keyFormat):
            print(f"Invalid entry {ent}")
            print(f"Must contain vname {keyFormat}")
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

        ent["index"] = index
        index = index + 1
    random.shuffle(configDict["conf"])
    return True


async def startDownloads(configList):
    global totalUrl
    global blocklistNotDownloaded
    global retryBlocklist
    global blocklistfiles

    downloadLoc = ""
    totalUrl = 0
    fileName = ""

    # realpython.com/python-concurrency/#asyncio-version
    async with aiohttp.ClientSession() as sess:
        tasks = []
        for value in configList:
            fileName = str(value["index"]).lower()

            if value["subg"].strip() == "":
                downloadLoc = "./" + blocklistfiles + "/" + value[
                    "group"].strip() + "/" + fileName + ".txt"
            else:
                downloadLoc = "./" + blocklistfiles + "/" + value[
                    "group"].strip() + "/" + value["subg"].strip(
                    ) + "/" + fileName + ".txt"

            if ('dead' in value["pack"]):
                totalUrl = totalUrl + 1
                print("\n" + str(totalUrl) + "; dead -> skip download")
                print(f"{value}\n")
                continue

            task = asyncio.ensure_future(
                downloadFile(sess, value["url"], value["format"], downloadLoc))
            tasks.append(task)

        # docs.python.org/3/library/asyncio-task.html#running-tasks-concurrently
        rets = await asyncio.gather(*tasks, return_exceptions=True)

        for ret in rets:
            if (not ret) and ('ignore' in value["pack"]):
                blocklistNotDownloaded.append(str(value))
            elif ret == "retry":
                retryBlocklist.append(value)
            elif not ret:
                print(f"\n\nblocklist not downloaded:\n{value}\n")
                # FIXME: continue with warning
                # sys.exit("")


def createFileNotExist(filename):
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
        createFileNotExist(download_loc_filename)
        with open(download_loc_filename, "w") as f:
            f.write(safeStr(txt))
            f.close()
        savedUrl = savedUrl + 1
        return True
    else:
        return False


def urllibRequestApi(url):
    try:
        response = urllib.request.urlopen(url)
        data = response.read()
        r = data.decode('utf-8')
        return r
    except Exception as e:
        print("Exception")
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
async def downloadFile(sess, urls, formats, download_loc_filename):
    global totalUrl
    totalUrl = totalUrl + 1
    print(str(totalUrl) + "; src: " + urls + " | dst: " + download_loc_filename)
    ret = True
    blocklist = True
    txt = ""

    if type(urls) is str:
        ul = list()
        ul.append(urls)
        urls = ul
    if type(formats) is str:
        fl = list()
        fl.append(formats)
        formats = fl

    for i in range(0, len(urls)):
        url = urls[i]
        format = formats[i]
        print(f"\n processing {url} of type {format}")

        try:
            blocklist = await requestApi(sess, url)
        except Exception as e:
            print(f"\nErr downloading {url}\n{e}")
            return "retry"

        if format == "wildcard":
            domains = extractDomains(blocklist, r'(^\*\.)([a-zA-Z0-9][a-zA-Z0-9-_.]+)', 1)
        elif format == "domains":
            domains = extractDomains(blocklist, r'(^[a-zA-Z0-9][a-zA-Z0-9-_.]+)', 0)
        elif format == "hosts":
            domains = extractDomains(
                blocklist, r'(^([0-9]{1,3}\.){3}[0-9]{1,3})([ \t]+)([a-zA-Z0-9-_.]+)', 3)
        elif format == "abp":
            domains = extractDomains(blocklist,
            r'^(\|\||[a-zA-Z0-9])([a-zA-Z0-9][a-zA-Z0-9-_.]+)((\^[a-zA-Z0-9\-\|\$\.\*]*)|(\$[a-zA-Z0-9\-\|\.])*|(\\[a-zA-Z0-9\-\||\^\.]*))$',
            1)

        if (len(domains) > 0):
            if (len(txt) > 0):
                txt = txt + "\n" + domains
            else:
                txt = domains

    ret = writeFile(download_loc_filename, txt)

    if not ret:
        print("\n\nDownloaded file empty or has no entries\n")
        print(url + " : " + download_loc_filename + "\n")

    return ret


def loadBlocklistConfig():
    done = False
    global configDict

    try:
        if os.path.isfile(configFileLocation):
            with open(configFileLocation) as json_file:
                configDict = json.load(json_file)
                json_file.close()
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
    global blocklistNotDownloaded
    global configDict
    global retryBlocklist

    ok = loadBlocklistConfig()

    if not ok:
        print("Error loading config, download aborted.")
        sys.exit("")

    tmpRetryBlocklist = list()
    exitWithError = False
    if validConfig():
        asyncio.run(startDownloads(configDict["conf"]))

        print("\nTotal blocklists: " + str(totalUrl))
        print("Saved blocklists: " + str(savedUrl))
        print("Difference: " + str(totalUrl - savedUrl))

        if len(retryBlocklist) >= 1:
            print("\n\nretry download blocklist\n\n")
            tmpRetryBlocklist = retryBlocklist
            retryBlocklist = list()
            asyncio.run(startDownloads(tmpRetryBlocklist))

        if len(blocklistNotDownloaded) >= 1:
            print("\n\nFailed download list:")
            print("\n".join(blocklistNotDownloaded))

        if len(retryBlocklist) >= 1:
            print("\nError downloading blocklist\n")
            for value in retryBlocklist:
                if not ('ignore' in value["pack"]):
                    exitWithError = True
                print(f"{value}\n")
            if exitWithError:
                sys.exit("")
    else:
        print("Validation Error")
        sys.exit("")


if __name__ == "__main__":
    main()
