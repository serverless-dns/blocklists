/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const onetick = 7; // approx. one week

export function genVersion(epochSec = 0) {
  if (epochSec <= 0) throw new Error("ver: invalid epoch");
  const d = new Date(epochSec * 1000);
  // keep this in sync with dl.rdns
  // ex: yyyy/timesampMs; 2022/1664574546478
  return d.getUTCFullYear() + "/" + d.getTime();
}

export function genVersion7(epochSec = 0) {
  if (epochSec <= 0) throw new Error("ver7: invalid epoch");
  const d = new Date(epochSec * 1000);
  // keep this in sync with dl.rdns
  // ex: yyyy/mm-week; 2022/11-1 or 2022/11-5
  const wk = Math.ceil(d.getDate() / onetick);
  const mm = d.getUTCMonth() + 1;
  // must be same as serverless-dns:src/build/pre.sh
  return d.getUTCFullYear() + "/bc/" + mm + "-" + wk;
}
