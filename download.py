import os
import sys
import json 
import requests
import errno
import re
import time
from urllib.parse import urlparse
import random


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
        if len(value) != 6:            
            print ("Invalid Blocklist config Format")
            print (value)
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

    
def parseDownloadBasicConfig():
    global totalUrl   
    global unameVnameMap
    downloadLoc = ""
    totalUrl = 0
    fileName = ""
    
    for value in configDict["conf"]:
        if str(value["index"]) in unameVnameMap:
            fileName = unameVnameMap[str(value["index"])]
        else:
            fileName = str(value["index"])

        if value["subg"].strip() == "":
            downloadLoc = "./blocklistfiles/" + value["group"].strip() + "/" + fileName + ".txt"
        else:
            downloadLoc = "./blocklistfiles/" + value["group"].strip() + "/"  + value["subg"].strip() + "/" + fileName + ".txt"

        
        #print (downloadLoc)
        if('disintegrated' in value["pack"]):
            print("\n\nDisintegrated blocklist -> skip download")
            print(value)
            print("\n")
            continue
        ret = downloadFile(value["url"],value["format"],downloadLoc)            
        if not ret:
            print("\n\nFollowing blocklist not downloaded")
            print(value)
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
    
    if format != "wildcard" and len(domainlist) <= 10:
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

def fetch(url):
    try:
        r = requests.get(url)
        return r          
    except:
        
        return False
def downloadFile(url,format,download_loc_filename):  
    global totalUrl  
    totalUrl = totalUrl + 1
    print (str(totalUrl) +" : Downloading From : "+url)
    print ("Download Location : "+download_loc_filename)
    ret = True
    r = fetch(url)
    retryCount = 0
    while((not r) and (retryCount < blocklistDownloadRetry)):
        time.sleep(2)
        print ("\n\n"+str(totalUrl) +" : Exception Retry After Sleep : "+url)
        r = fetch(url)
        retryCount = retryCount + 1
    
    if(not r):
        print("\n\nException in downloading file")
        print("Exception : "+ url +" : "+download_loc_filename)
        return False

    if format == "domains" or format == "wildcard":        
        filetxt = regxFileDomain(r.text,r'(^[a-zA-Z0-9][a-zA-Z0-9-_.]+)',0,format)        
    elif format == "hosts":
        filetxt = regxFileDomain(r.text,r'(^([0-9]{1,3}\.){3}[0-9]{1,3})([ \t]+)([a-zA-Z0-9-_.]+)',3,format)
    elif format == "abp":
        filetxt = regxFileDomain(r.text,r'^(\|\||[a-zA-Z0-9])([a-zA-Z0-9][a-zA-Z0-9-_.]+)((\^[a-zA-Z0-9\-\|\$\.\*]*)|(\$[a-zA-Z0-9\-\|\.])*|(\\[a-zA-Z0-9\-\||\^\.]*))$',1,format)               

    ret = writeFile(download_loc_filename,filetxt)
    if not ret:
        print("\n\n\n\n\nDownloaded file may be empty or contains less than 10 entries")
        print(url +" : "+download_loc_filename)
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

    loadBlocklistConfig()
    
    if isConfigLoad:
        if validateBasicConfig():
            parseDownloadBasicConfig()                                               
            
            print ("Total blocklist : "+str(totalUrl))
            print ("Download and saved blocklist : "+str(savedUrl))
            print ("Difference : "+str(totalUrl-savedUrl))
        else:
            print ("Validation Error")
            sys.exit("")
        
    else:
        print("Error in loading BasicConfigFile for Download Process")
    
        
main()