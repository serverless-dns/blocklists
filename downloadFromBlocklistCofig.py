import os
import sys
import json 
import requests
import errno
import re
from urllib.parse import urlparse


notdownloaded = []
config_file_location = "./blocklistconfig.json"
isconfigload = False
configdict = {}
valueExist = set()
urlExist = set()
unameExist = set()
keyFormat = {"fileloc", "value", "vname", "uname", "format", "group", "subg", "url"}
supportedFileFormat = {"domains", "hosts", "abp"}
totalurl = 0
savedurl = 0

        
    
def ValidateBasicConfig():
    global keyFormat    
    failed = 0
    downloadLoc = ""
    for value in configdict["conf"]:
        if len(value) != 8:            
            print ("Invalid Blocklist config Format")
            print (value)
            return False

        if not keyFormat <= set(value):
            print ("Invalid key format")
            print (value)
            return False

        if value["value"] in valueExist:
            print ("Value Already Exist in Blocklist config json")
            print (value)
            return False
        else:
            valueExist.add(value["value"])

        if value["url"] in urlExist:
            print ("Url Already Exist in Blocklist config json")
            print (value)
            return False
        else:
            urlExist.add(value["url"])
            
        if len(value["uname"]) != 3:
            print ("Uanme should be in 3 character length")
            return False

        if value["uname"] in unameExist:
            print ("Uname Already Exist in Blocklist config json")
            print(value)
            return False
        else:
            unameExist.add(value["uname"])

        if not value["format"] in supportedFileFormat:
            print ("Added file format not supported currently")
            print (value)
            return False

        if value["group"].strip() == "":
            print ("group name mandatory")
            print (value)
            return False
    return True          

    
def ParseDownloadBasicConfig():
    global totalurl   
    downloadLoc = ""
    for value in configdict["conf"]:
        totalurl = totalurl + 1
        if value["subg"].strip() == "":
            downloadLoc = "./blocklistfiles/" + value["group"].strip() + "/" + value["uname"] + ".txt"
        else:
            downloadLoc = "./blocklistfiles/" + value["group"].strip() + "/"  + value["subg"].strip() + "/" + value["uname"] + ".txt"

        ret = downloadfile(value["url"],value["format"],downloadLoc)            


def createfilenotexist(filename):
    if not os.path.exists(os.path.dirname(filename)):
        try:
            os.makedirs(os.path.dirname(filename))
        except OSError as exc: # Guard against race condition
            if exc.errno != errno.EEXIST:
                raise

def safe_str(obj):
    try: return str(obj)
    except UnicodeEncodeError:
        return obj.encode('ascii', 'ignore').decode('ascii')
    return ""

def regx_file_domain(txt,regx_str,grp_index):
    domainlist = set()
    abp_regx = re.compile(regx_str,re.M)
    for match in re.finditer(abp_regx, txt):
        g2 = match.groups()[grp_index]
        g2 = g2.strip()
        if g2 and g2[-1]!='.':
            domainlist.add(g2)
    

    return "\n".join(domainlist)
    
def write_file(download_loc_filename,filetxt):
    global savedurl
    if filetxt:
        createfilenotexist(download_loc_filename)         
        with open(download_loc_filename, "w") as f:  
            f.write(safe_str(filetxt))  
            f.close()
        savedurl = savedurl + 1
        return True
    else:        
        return False
        
def downloadfile(url,format,download_loc_filename):  
    global totalurl  
    print (str(totalurl) +" : Downloading From : "+url)
    ret = True
    try:
        r = requests.get(url)          
    except:
        notdownloaded.append("Exception : "+ url +" : "+download_loc_filename)
        return False
    if format == "domains":        
        filetxt = regx_file_domain(r.text,r'(^[a-zA-Z0-9][a-zA-Z0-9-_.]+)',0)
        ret = write_file(download_loc_filename,filetxt)
        if not ret:
            notdownloaded.append(url +" : "+download_loc_filename)
    elif format == "hosts":
        filetxt = regx_file_domain(r.text,r'(^([0-9]{1,3}\.){3}[0-9]{1,3})([ \t]+)([a-zA-Z0-9-_.]+)',3)
        ret = write_file(download_loc_filename,filetxt)
        if not ret:
            notdownloaded.append(url +" : "+download_loc_filename) 
    elif format == "abp":
        filetxt = regx_file_domain(r.text,r'^(\|\||[a-zA-Z0-9])([a-zA-Z0-9][a-zA-Z0-9-_.]+)((\^[a-zA-Z0-9\-\|\$\.\*]*)|(\$[a-zA-Z0-9\-\|\.])*|(\\[a-zA-Z0-9\-\||\^\.]*))$',1)               
        ret = write_file(download_loc_filename,filetxt)
        if not ret:
            notdownloaded.append(url +" : "+download_loc_filename)

    return ret
def load_blocklistconfig():
    global isconfigload
    global configdict
    if os.path.isfile(config_file_location):
        with open(config_file_location) as json_file: 
            configdict = json.load(json_file) 
            json_file.close()
            if "conf" in configdict:
                isconfigload = True
    if not isconfigload:
        configdict["conf"] = {}
        
def main():
    global totalurl
    global savedurl

    load_blocklistconfig()
    
    if isconfigload:
        if ValidateBasicConfig():

            ParseDownloadBasicConfig()

            print ("\n\n\n\n\n\nFile Not Downloaded")
            print ("\n".join(notdownloaded))                                                    
            
            print ("Total Url Found : "+str(totalurl))
            print ("Download and Saved Url : "+str(savedurl))
            print ("diff : "+str(totalurl - savedurl))
        else:
            sys.exit("Error Occured")
        
    else:
        print("Error in loading BasicConfigFile for Download Process")
    
        
main()