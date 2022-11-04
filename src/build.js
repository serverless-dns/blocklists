/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as fs from "fs";
import * as path from "path";
import * as trie from "trie";
import * as log from "./log.js";
import { genVersion } from "./ver.js";

const outdir = process.env.OUTDIR;
const indir = process.env.INDIR;
const blconfigjson = process.env.BLCONFIG;
const codec = process.env.CODEC || "u6";
const tstamp = process.env.UNIX_EPOCH_SEC;

function empty(str) {
  return !str;
}

function opts() {
  const usec6 = "u6" === codec;
  const v = genVersion(tstamp);
  return { timestamp: v, useCodec6: usec6 };
}

async function getBlocklistFiles(bldir) {
  const blocklists = [];
  const dirs = [bldir];
  let d = null;
  // all files from bldir, incl sub-directories
  while ((d = dirs.shift())) {
    const dir = await fs.promises.opendir(d);
    for await (const entry of dir) {
      const x = path.join(d, entry.name);
      if (entry.isDirectory()) {
        dirs.push(x);
      } else {
        blocklists.push(x);
      }
    }
  }
  return blocklists;
}

function loadConfig(blocklistConfigPath) {
  try {
    const tags = {};
    const fileData = fs.readFileSync(blocklistConfigPath, "utf8");
    const blocklistobj = JSON.parse(fileData);

    for (const [id, entry] of Object.entries(blocklistobj.conf)) {
      const uid = id + ""; // string, must be lowercase

      tags[uid] = {
        value: parseInt(id),
        // uname exists in celzero/gotrie, and so continue to
        // set it despite the existence of the "value" field
        // ref: github.com/celzero/gotrie/blob/d9d0dcea/trie/frozentrie.go#L334
        uname: id + "",
        vname: entry.vname,
        group: entry.group,
        subg: entry.subg,
        url: entry.url,
        show: 0,
        entries: 0,
      };
      log.i("btag for " + uid + " index: " + id, "in", tags[uid].group);
    }
    return tags;
  } catch (e) {
    log.e(e);
    throw e;
  }
}

async function main() {
  if (empty(indir) || empty(outdir) || empty(blconfigjson)) {
    log.e("missing: indir / outdir / config", indir, outdir, blconfigjson);
    return;
  }

  const o = opts();
  const triedir = path.normalize(`./${outdir}/`);
  const bldir = path.normalize(`./${indir}/`);
  const blconfig = path.normalize(`${blconfigjson}`);

  try {
    const tags = loadConfig(blconfig);
    const bl = await getBlocklistFiles(bldir);
    log.i(o, "build, out: " + triedir + ", in: " + bl + ", tags: " + tags);
    await trie.build(bl, triedir, tags, o);
  } catch (e) {
    log.e(e);
    process.exitCode = 1;
  }
}

(async () => {
  await main();
})();
