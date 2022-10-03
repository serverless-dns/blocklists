/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const os = require("node:os");
const process = require("node:process");

// a simple logger that prints time on every output
const E = "E/";
const W = "W/";
const I = "I/";
const D = "D/";

function d(...args) {
    console.debug(t(), D, ...args);
}

function i(...args) {
    console.info(t(), I, ...args);
}

function w(...args) {
    console.warn(t(), W, ...args);
}

function e(...args) {
    console.error(t(), E, ...args);
}

function t() {
    return new Date().toISOString();
}

function sys() {
    const btomb = 1000 * 1000;
    const kbtomb = 1000;
    const utosec = 1000 * 1000;
    const meminfo = process.memoryUsage(); // is slow
    const procinfo = process.resourceUsage();
    // os info
    const loadavg = os.loadavg().map(avg => avg / btomb);
    const freemem = os.freemem()/ btomb;
    const totalmem = os.totalmem() / btomb;
    // memory info
    const rss = meminfo.rss / btomb;
    const totalheap = meminfo.heapTotal / btomb;
    const usedheap = meminfo.heapUsed / btomb;
    const ext = meminfo.external / btomb;
    const buf = meminfo.arrayBuffers / btomb;
    // proc info
    const userslice = procinfo.userCPUTime / utosec;
    const systemslice = procinfo.systemCPUTime / utosec;
    const maxrss = procinfo.maxRSS / kbtomb;
    const minorpf = procinfo.minorPageFault;
    const majorpf = procinfo.majorPageFault;
    i("<meminfo>",
        "| rss", rss,
        "| heap-total", totalheap,
        "| heap-used", usedheap,
        "| external", ext,
        "| buffers", buf);
    i("<osinfo>",
        "| cpu-avg", loadavg,
        "| mem-free", freemem,
        "| mem-use", totalmem);
    i("<procinfo>",
        "| user", userslice,
        "| system", systemslice,
        "| maxrss", maxrss,
        "| minor", minorpf,
        "| major", majorpf);
}

module.exports = {
    d, i, w, e, sys
};