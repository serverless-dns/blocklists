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

    encode(str6or8) {
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

    decode(u6or8) {
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

    decode16(u6or8) {
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

    encode16(str16) {
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

    extern6(str16, start=0) {
        const W = 16;
        let p = start;
        let n = 6;
        let m = p % W;
        let i = (p / W) | 0;
        let num = 0; // u6

        if (i >= str16.length) return null;

        if (m + n <= W) {
            const u = ord16.get(str16[i]);
            // case 1: bits lie within the given byte
            num = (u & lsb16[m]) >> (W - m - n);
            // log("num0", num, "p", p, "l", W - m, "n", n,
            // "s["+i+"]", u, (u).toString(2).padStart(16, "x"));
        } else {
            const u1 = ord16.get(str16[i]);
            // case 2: bits lie incompletely in the given byte
            num = u1 & lsb16[m];

            let l = W - m;
            // log("num1", num, "p", p, "l", l, "n", n, "u["+i+"]",
            // u1, (u1).toString(2).padStart(16, "x"));
            p += l;
            n -= l;
            // always 0 since p hereon is always a factor of W
            m = p % W;
            // or: i += 1 also works
            i = (p / W) | 0;

            if (n > 0 && i < str16.length) {
                const u2 = ord16.get(str16[i]);
                const r = W - n;
                num = (num << n) | (u2 >> r);
            }
            // log("num2", num, "p", p, "l", l, "n", n,
            // "s["+i+"]", u2, (u2).toString(2).padStart(16, "x"));
        }
        // log("u6", (num).toString(2).padStart(6, "x"));
        // the encoding is big-endian; ie, the higher
        // bits in str16 map to higher bits in num
        return num;
    }

    intern16(u6, start=0) {
        let str16 = "";
        const W = 6;
        let p = start;
        let n = 16;
        let m = p % W;
        let i = (p / W) | 0;

        let num = 0;
        while (n >= W) {
            const l = W - m;
            let u = 0;
            if (i < u6.length) {
                u = u6[i] & lsb6[m];
            }
            num = (num << l) | u;
            // log("num", num, "p", p, "l", l, "n", n, "r", r, "m", m,
            // "u["+i+"]", u6[i], "\n", (u6[i]).toString(2).padStart(6, "x"),
            // (num).toString(2).padStart(16, "x"));
            n -= l;
            p += l;
            // m is mostly 0, as p is a mostly a factor of W
            m = p % W;
            // or: i += 1 also works just the same
            i = (p / W) | 0;
        }

        // the final bits 'n' are only a part of the 6-bit u6[i]
        if (n > 0) {
            const r = W - n;
            let u = 0;
            if (i < u6.length) {
                u = u6[i] & lsb6[m];
            }
            num = (num << n) | (u >> r);
        }

        str16 = chr16.get(num);
        // log("return", str16, num, (num).toString(2).padStart(16, "x"));

        return str16;
    }

    e16(str16) {
        if (this.typ === b8) {
            // returns u8
            return this.encode(str16);
        }
        const n = 6;
        const len16 = str16.length * 16;
        const len6 = Math.ceil(len16 / n);
        const u6 = new Uint8Array(len6);
        for (let i = 0; i < len6; i += 1) {
            const u = this.extern6(str16, Math.min(i * n, len16));
            if (u != null) u6[i] = u;
        }
        return u6;
    }

    d16(u6or8) {
        if (this.typ === b8) {
            // returns str16
            return this.decode(u6or8);
        }
        const u6 = u6or8;
        const n = 16;
        const len6 = u6.length * 6;
        const len16 = Math.ceil(len6 / n);
        let str16 = "";
        for (let i = 0; i < len16; i += 1) {
            str16 += this.intern16(u6, Math.min(i * n, len6));
        }
        return str16;
    }

    delimEncoded() {
        return this.encode(delim);
    }

    periodEncoded() {
        return this.encode(period);
    }
}

module.exports = {
    b6, b8, delim, Codec
};

const msb6 = [
    0x3f,
    0x3e,
    0x3c,
    0x38,
    0x30,
    0x20,
    0x00
];


const lsb6 = [
    0x3f,
    0x1f,
    0x0f,
    0x07,
    0x03,
    0x01,
    0x00
];

const lsb16 = [
    0xffff,
    0x7fff,
    0x3fff,
    0x1fff,
    0x0fff,
    0x07ff,
    0x03ff,
    0x01ff,
    0x00ff,
    0x007f,
    0x003f,
    0x001f,
    0x000f,
    0x0007,
    0x0003,
    0x0001,
    0x0000
];

const msb16 = [
    0xffff,
    0xfffe,
    0xfffc,
    0xfff8,
    0xfff0,
    0xffe0,
    0xffc0,
    0xff80,
    0xff00,
    0xfe00,
    0xfc00,
    0xf800,
    0xf000,
    0xe000,
    0xc000,
    0x8000,
    0x0000
];