import os
import errno
import json
import random
import re
import requests
import sys
import time
import urllib.request
from urllib.parse import urlparse



configFileLocation = "./blocklistConfig.json"
vnameMapFileLocation = "./valueUnameMap.json"
isConfigLoad = False
configDict = {}
unameVnameMap = {}
valueExist = set()
urlExist = set()
unameExist = set()
keyFormat = {"vname",  "format", "group", "subg", "url", "pack"}
supportedFileFormat = {"domains", "hosts", "abp", "wildcard"}
totalUrl = 0
savedUrl = 0
blocklistDownloadRetry = 3
blocklistNotDownloaded = list()
retryBlocklist = list()
def validateBasicConfig():
    global keyFormat
    failed = 0
    downloadLoc = ""
    index = 0
    regex = re.compile(
        r'^(?:http|ftp)s?://'
        r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z]{2,6}\.?|[A-Z0-9-]{2,}\.?)|'
        r'localhost|'
        r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})'
        r'(?::\d+)?'
        r'(?:/?|[/?]\S+)$', re.IGNORECASE)

    for value in configDict["conf"]:
        if len(value) != len(keyFormat):            
            print ("Invalid Blocklist config Format")            
            print (value)
            print ("Should contain below fields")
            print (keyFormat)
            return False

        if not keyFormat <= set(value):
            print ("Invalid key format")
            print (value)
            return False


        if re.match(regex, value["url"]) is None:
            print ("Invalid url format")
            print (value)
            return False

        if value["url"] in urlExist:
            print ("Url Already Exist in Blocklist config json")
            print (value)
            return False
        else:
            urlExist.add(value["url"])


        if not value["format"] in supportedFileFormat:
            print ("Added file format not supported currently")
            print (value)
            return False

        if value["group"].strip() == "":
            print ("group name mandatory")
            print (value)
            return False

        value["index"] = index
        index = index + 1
    random.shuffle(configDict["conf"])
    return True          

def parseDownloadBasicConfig(configList):
    global totalUrl
    global unameVnameMap
    global blocklistNotDownloaded
    global retryBlocklist

    downloadLoc = ""
    totalUrl = 0
    fileName = ""
    
    for value in configList:
        if str(value["index"]) in unameVnameMap:
            fileName = unameVnameMap[str(value["index"])]
        else:
            fileName = str(value["index"])

        if value["subg"].strip() == "":
            downloadLoc = "./blocklistfiles/" + value["group"].strip() + "/" + fileName + ".txt"
        else:
            downloadLoc = "./blocklistfiles/" + value["group"].strip() + "/"  + value["subg"].strip() + "/" + fileName + ".txt"

        
        #print (downloadLoc)
        if('deprecated' in value["pack"]):
            totalUrl = totalUrl + 1
            print("\n"+str(totalUrl)+":")
            print("Deprecated  blocklist -> skip download")
            print(value)
            print("\n")            
            continue
        ret = downloadFile(value["url"],value["format"],downloadLoc)     

        if (not ret) and ('try again' in value["pack"]):
            blocklistNotDownloaded.append(str(value))
            print("\n")
        elif ret == "retry":
            retryBlocklist.append(value)
        elif not ret:
            print("\n\nFollowing blocklist not downloaded")
            print(value)
            print("\n")
            sys.exit("")
    

def createFileNotExist(filename):
    if not os.path.exists(os.path.dirname(filename)):
        try:
            os.makedirs(os.path.dirname(filename))
        except OSError as exc: # Guard against race condition
            if exc.errno != errno.EEXIST:
                raise

def safeStr(obj):
    try: return str(obj)
    except UnicodeEncodeError:
        return obj.encode('ascii', 'ignore').decode('ascii')
    return ""

def regxFileDomain(txt,regx_str,grp_index,format):
    domainlist = set()
    abp_regx = re.compile(regx_str,re.M)
    for match in re.finditer(abp_regx, txt):
        g2 = match.groups()[grp_index]
        g2 = g2.strip()
        if g2 and g2[-1]!='.':
            domainlist.add(g2)
    
    if format != "wildcard" and len(domainlist) <= 8:
        return ""

    return "\n".join(domainlist)

def writeFile(download_loc_filename,filetxt):
    global savedUrl
    if filetxt and filetxt != "":
        createFileNotExist(download_loc_filename)         
        with open(download_loc_filename, "w") as f:  
            f.write(safeStr(filetxt))  
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

def requestApi(url):
    try:
        r = requests.get(url)
        return r.text          
    except Exception as e:
        print("\nException\n")    
        print(e)
        return False

def downloadFile(url,format,download_loc_filename):  
    global totalUrl  
    totalUrl = totalUrl + 1
    print (str(totalUrl) +" : Downloading From : "+url)
    print ("Download Location : "+download_loc_filename)
    ret = True
    r = requestApi(url)
    
    if(not r):
        print("\nException in downloading file")
        print("Exception : "+ url +" : "+download_loc_filename)
        return "retry"

    if format == "domains" or format == "wildcard":        
        filetxt = regxFileDomain(r,r'(^[a-zA-Z0-9][a-zA-Z0-9-_.]+)',0,format)        
    elif format == "hosts":
        filetxt = regxFileDomain(r,r'(^([0-9]{1,3}\.){3}[0-9]{1,3})([ \t]+)([a-zA-Z0-9-_.]+)',3,format)
    elif format == "abp":
        filetxt = regxFileDomain(r,r'^(\|\||[a-zA-Z0-9])([a-zA-Z0-9][a-zA-Z0-9-_.]+)((\^[a-zA-Z0-9\-\|\$\.\*]*)|(\$[a-zA-Z0-9\-\|\.])*|(\\[a-zA-Z0-9\-\||\^\.]*))$',1,format)               

    ret = writeFile(download_loc_filename,filetxt)
    if not ret:
        print("\n\nDownloaded file may be empty or contains less than 10 entries")
        print(url +" : "+download_loc_filename)
        print("\n")
    return ret
def loadBlocklistConfig():
    global isConfigLoad
    global configDict
    global unameVnameMap
    try:
        if os.path.isfile(configFileLocation):
            with open(configFileLocation) as json_file:
                configDict = json.load(json_file)
                json_file.close()
                if "conf" in configDict:
                    isConfigLoad = True
        if not isConfigLoad:
            configDict["conf"] = {}

        if os.path.isfile(vnameMapFileLocation):
            with open(vnameMapFileLocation) as json_file:
                unameVnameMap = json.load(json_file)
                json_file.close()

    except:
        print ("Error in parsing Blocklist json file.")
        print ("Check json format")
        sys.exit("Error Occured")


def main():
    global totalUrl
    global savedUrl
    global blocklistNotDownloaded
    global configDict
    global retryBlocklist
    tmpRetryBlocklist = list()
    loadBlocklistConfig()
    exitWithError = False
    if isConfigLoad:
        if validateBasicConfig():
            parseDownloadBasicConfig(configDict["conf"])                                               
            

            if len(retryBlocklist) >= 1:
                print("\n\nretry download block list\n\n")
                tmpRetryBlocklist = retryBlocklist
                retryBlocklist = list()
                parseDownloadBasicConfig(tmpRetryBlocklist)

            
            print("\n\nTry later blocklist not downloaded")
            print("\n".join(blocklistNotDownloaded))


            print ("\nTotal blocklist : "+str(totalUrl))
            print ("Download and saved blocklist : "+str(savedUrl))
            print ("Difference : "+str(totalUrl-savedUrl))

            if len(retryBlocklist) >= 1:
                print ("\nError in downloading blocklist\n")
                for value in retryBlocklist:
                    if not ('try again' in value["pack"]):
                        exitWithError = True
                    print(value)
                    print("\n")
                if exitWithError:
                    sys.exit("")
        else:
            print ("Validation Error")
            sys.exit("")

    else:
        print("Error in loading BasicConfigFile for Download Process")


main()
