/*
 * Copyright (c) 2022 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const encNative = new TextEncoder();
const decNative = new TextDecoder();

const b8 = 8;
const b6 = 6;

// a char that's not in b32, b64 set; used to demarc
// key (domain) from value (blocklist); see trie.build
const delim = "#"; // ascii: 35
// some domains are registered with _ and even work just fine
// ex: prebid_stats.mars.media
const underscore = "_"; // ascii: 95

// rfc-editor.org/rfc/rfc1035#section-2.3.1 characters
const period = "."; // ascii: 46
const numerals = "01234567890"; // ascii: 48..57
const alphabet = "abcdefghijklmnopqrstuvwxyz"; // ascii: 97..122
const hyphen = "-"; // ascii: 45
const asterix = "*"; // ascii: 42

// must be in lexographical order as defined by ascii/utf8; see trie.build
const validchars6 = delim + asterix + hyphen + period + numerals + underscore + alphabet;

const memstat = {encode: 0, decode: 0, encode16: 0, decode16: 0};
const memencode = new Map();
const memencode16 = new Map();
const memdecode = new Map();
const memdecode16 = new Map();

const {map: ord6, rev: chr6} = index6(validchars6);
const {map: ord16, rev: chr16} = index16();

function index16() {
    return {
        map: {get: (c) => c.charCodeAt(0)},
        rev: {get: (n) => String.fromCharCode(n)}
    };
}

// encode and decode adopted from:
// github.com/serverless-dns/serverless-dns/blob/d72be3f/src/commons/b32.js
function index6(str) {
    const m = new Map();
    const r = new Map();
    let i = 0;
    for (const c of str) {
        m.set(c, i);
        r.set(i, c);
        i += 1;
    }
    return {map: m, rev: r};
}

class Codec {
    constructor(typ = 8) {
        // either b8 or b5
        this.typ = typ;
    }

    encode(str6or8, pool = true) {
        if (pool) {
            const u6or8 = memencode.get(str6or8);
            if (u6or8 != null) {
                memstat.encode += 1;
                return u6or8;
            }
        }

        const u6or8 = this.encodeinner(str6or8);
        if (pool) memencode.set(str6or8, u6or8);

        return u6or8;
    }

    decode(u6or8, pool = true) {
        let k = null;
        if (pool) {
            k = u6or8.join(",");
            const str6or8 = memdecode.get(k);
            if (str6or8 != null) {
                memstat.decode += 1;
                return str6or8;
            }
        }

        const str6or8 = this.decodeinner(u6or8);
        if (pool && k) memdecode.set(k, str6or8);

        return str6or8;
    }

    encodeinner(str6or8) {
        if (this.typ === b8) {
            const str8 = str6or8;
            // returns u8
            return encNative.encode(str8);
        }
        const str6 = str6or8.toLowerCase();
        const u6 = new Uint8Array(str6.length);
        let i = 0;
        for (const c of str6) {
            const n = ord6.get(c);
            if (n != null) u6[i++] = n;
            else throw new Error("encode: undef num: " + n + ", for: " + c + ", in: " + str6 + ", res: " + u6);
        }
        return u6;
    }

    encode16(str16, pool = true) {
        if (pool) {
            const u6or8 = memencode16.get(str16);
            if (u6or8 != null) {
                memstat.encode16 += 1;
                return u6or8;
            }
        }

        const u6or8 = this.encode16inner(str16);
        if (pool) memencode16.set(str16, u6or8);

        return u6or8;
    }

    decode16(u6or8, pool = true) {
        let k = null;
        if (pool) {
            k = u6or8.join(",");
            const str16 = memdecode16.get(k);
            if (str16 != null) {
                memstat.decode16 += 1;
                return str16;
            }
        }

        const str16 = this.decode16inner(u6or8);
        if (pool && k) memdecode16.set(k, str16);

        return str16;
    }

    decodeinner(u6or8) {
        if (this.typ === b8) {
            const u8 = u6or8;
            // returns str8or16
            return decNative.decode(u8);
        }
        const u6 = u6or8;
        let str6 = "";
        for (const i of u6) {
            const c = chr6.get(i);
            if (c != null) str6 += c;
            else throw new Error("decode: undef char: " + c + ", for: " + i + ", in: " + u6 + ", res: " + str6);
        }
        return str6;
    }

    encode16inner(str16) {
        if (this.typ === b8) {
            // returns u8
            return this.encode(str16);
        }

        const W = 16;
        const n = 6;
        const mask = (2 ** n) - 1;
        const len16 = str16.length;
        const len6 = Math.ceil(len16 * W / n);
        let bits = 0;
        let acc = 0;
        let u6 = new Uint8Array(len6);
        let j = 0;

        for (let i = 0; i < len16; i += 1) {
          acc = (acc << W) | ord16.get(str16[i]);
          bits += W;

          while (bits >= n) {
            u6[j++] = (acc >>> (bits - n)) & mask;
            bits -= n;
          }
        }

        if (bits > 0) {
            u6[j++] = (acc << (n - bits)) & mask;
        }
        return u6;
    }

    decode16inner(u6or8) {
        if (this.typ === b8) {
            // returns str16
            return this.decode(u6or8);
        }

        const u6 = u6or8;
        const W = 6;
        const n = 16;
        const mask = (2 ** n) - 1;
        const len6 = u6.length;
        let bits = 0;
        let acc = 0;
        let str16 = "";

        for (let i = 0; i < len6; i += 1) {
          acc = (acc << W) | u6[i];
          bits += W;

          if (bits >= n) {
            str16 += chr16.get((acc >>> (bits - n)) & mask);
            bits -= n;
          }
        }
        return str16;
    }

    decode16raw(u6or8) {
        // returns u16
        const str16 = this.decode16(u6or8);
        const u16 = new Uint16Array(str16.length);
        let i = 0;
        for (const c of str16) {
            u16[i++] = ord16.get(c);
        }
        return u16;
    }

    delimEncoded() {
        return this.encode(delim);
    }

    periodEncoded() {
        return this.encode(period);
    }

    stats() {
        return memstat;
    }
}

module.exports = {
    b6, b8, delim, Codec
};
