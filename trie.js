/*
 * Copyright (c) 2020 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const log = require("./log.js");
const codec = require("./codec.js");
const { loadavg } = require("os");

// impl based on S Hanov's succinct-trie: stevehanov.ca/blog/?id=120

const BASE64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

let config = {
    // inspect trie building stats
    inspect: false,
    // binary-search (not linear) to lookup for words in the forzentrie
    useBinarySearch: true,
    // debug prints debug logs
    debug: false,
    // transforms select ops into rank ops with help of a modified l1/l2 layer
    selectsearch: true,
    // optimize pos0 impl by probing "longer steps" than usual
    fastPos: true,
    // useBuffer uses js typed-arrays instead of bit-strings
    useBuffer: true,
    // BitWriter packs bits in 16-bit char instead of an array
    write16: true,
    // use codec type b6 to convert js-str to bytes and vice-versa
    useCodec6: true,
    // optimize storing flags, that is, store less than 3 flags as-is
    optflags: true,
}

if (config.write16) {
    // write16 only works with array-buffer. see: BitWriter#getData
    config.useBuffer = true;
}

/**
 * Number of bits (width) of each encoding unit; ie 6 => base64.
 */
const W = 16

const bufferView = { 15: Uint16Array, 16: Uint16Array, 6: Uint8Array };

function CHR(ord) {
    return CHRM(ord, W === 6)
}

function CHR16(ord) {
    return CHRM(ord, false)
}

/**
 * Returns the character unit that represents the given value. If this were
 * binary data, we would simply return id.
 */
function CHRM(ord, b64) {
    return (b64) ? BASE64[ord] : String.fromCharCode(ord);
}

/**
 * Returns the decimal value of the given character unit.
 */
const ORD = {};

for (let i = 0; i < BASE64.length; i++) {
    ORD[BASE64[i]] = i;
}

function DEC(chr) {
    return DECM(chr, W === 6);
}

function DEC16(chr) {
    return DECM(chr, false);
}

function DECM(chr, b64) {
    return (b64) ? ORD[chr] : chr.charCodeAt(0);
}

/**
 * Fixed values for the L1 and L2 table sizes in the Rank Directory
 */
const L1 = 32 * 32;
const L2 = 32;
const codecType = (config.useCodec6) ? codec.b6 : codec.b8;
const TxtEnc = new codec.Codec(codecType);
const TxtDec = TxtEnc;
// utf8 encoded delim for non-base32/64
const ENC_DELIM = TxtEnc.delimEncoded();
const periodEncVal = TxtEnc.periodEncoded();

/** maps int index to str tags */
const gtag = {};
/** maps str tags to int indices */
const gflag = {};

/**
 * The BitWriter will create a stream of bytes, letting you write a certain
 * number of bits at a time. This is part of the encoder, so it is not
 * optimized for memory or speed.
 */
function BitWriter() {
    this.init();
}

function getBuffer(size, nofbits) {
    return new bufferView[nofbits](size);
}

BitWriter.prototype = {

    init: function () {
        this.bits = [];
        this.bytes = [];
        this.bits16 = [];
        this.top = 0;
    },

    write16(data, numBits) {
        // todo: throw error?
        if (numBits > 16) {
            log.e("writes upto 16 lsb bits; out of range: " + numBits);
            return;
        }
        const n = data;
        const brim = 16 - (this.top % 16);
        const cur = (this.top / 16) | 0;
        const e = this.bits16[cur] | 0;
        let remainingBits = 0;
        // clear msb
        let b = n & BitString.MaskTop[16][16 - numBits];

        // shift to bit pos to be right at brim-th bit
        if (brim >= numBits) {
            b = b << (brim - numBits);
        } else {
            // shave right most bits if there are too many bits than
            // what the current element at the brim can accomodate
            remainingBits = (numBits - brim);
            b = b >>> remainingBits;
        }
        // overlay b on current element, e.
        b = e | b;
        this.bits16[cur] = b;

        // account for the left-over bits shaved off by brim
        if (remainingBits > 0) {
            b = n & BitString.MaskTop[16][16 - remainingBits];
            b = b << (16 - remainingBits);
            this.bits16[cur + 1] = b;
        }

        // update top to reflect the bits included
        this.top += numBits;
    },

    /**
     * Write some data to the bit string; number(bits) <= 32.
     */
    write: function (data, numBits) {
        if (config.write16) {
            while (numBits > 0) {
                // take 16 and then the leftover pass it to write16
                const i = (numBits - 1) / 16 | 0;
                const b = data >>> (i * 16);
                const l = (numBits % 16 === 0) ? 16 : numBits % 16;
                this.write16(b, l);
                numBits -= l;
            }
            return;
        }
        for (let i = numBits - 1; i >= 0; i--) {
            if (data & (1 << i)) {
                this.bits.push(1);
            } else {
                this.bits.push(0);
            }
        }
    },

    getData: function () {
        const conv = this.bitsToBytes();
        this.bytes = this.bytes.concat(conv);
        return (config.useBuffer) ? conv : this.bytes.join("");
    },

    /**
     * Get the bitstring represented as a javascript string of bytes
     */
    bitsToBytes: function () {

        if (config.write16) {
            if (config.useBuffer) {
                return bufferView[W].from(this.bits16);
            } // else error
            this.bits16 = [];
        }

        let n = this.bits.length;
        const size = Math.ceil(n / W);

        let chars = (config.useBuffer) ? getBuffer(size, W) : [];
        log.i("W/size/n ", W, size, n)
        let j = 0;
        let b = 0;
        let i = 0;
        while (j < n) {
            b = (b << 1) | this.bits[j];
            i += 1;
            if (i === W) {
                if (config.useBuffer) {
                    if (config.debug) log.d("i/j/W/n/s", i, j, W, n, size);
                    chars.set([b], (j / W) | 0)
                } else {
                    chars.push(CHR(b));
                }
                i = b = 0;
            }
            j += 1;
        }

        if (i !== 0) {
            b = b << (W - i);
            if (config.useBuffer) {
                chars.set([b], (j / W) | 0)
            } else {
                chars.push(CHR(b));
            }
            i = 0;
        }
        this.bits = [];

        return chars;
    }
};

/**
 * Given a string of data (eg, in BASE64), the BitString class supports
 * reading or counting a number of bits from an arbitrary position.
 */
function BitString(str) {
    this.init(str);
}

BitString.MaskTop = {
    16: [0xffff,
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
        0x0000]
};

BitString.MaskBottom = {
    16: [0xffff,
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
        0x0000]
};

const BitsSetTable256 = [];

// Function to initialise the lookup table
function initialize() {
    BitsSetTable256[0] = 0;
    for (let i = 0; i < 256; i++) {
        BitsSetTable256[i] = (i & 1) + BitsSetTable256[Math.floor(i / 2)];
    }
}

// Function to return the count of set bits in n
function countSetBits(n) {
    return (BitsSetTable256[n & 0xff] +
        BitsSetTable256[(n >>> 8) & 0xff] +
        BitsSetTable256[(n >>> 16) & 0xff] +
        BitsSetTable256[n >>> 24]);
}

function bit0(n, p, pad) {
    const r = bit0p(n, p);
    if (r.scanned <= 0) return r.scanned; // r.index
    if (r.index > 0) return r.scanned; // r.index
    if (pad > r.scanned) return r.scanned + 1; // + 1
    else return 0;
}

/**
 * Find the pth zero bit in the number, n.
 * @param {*} n The number, which is usually unsigned 32-bits
 * @param {*} p The pth zero bit
 */
function bit0p(n, p) {
    if (p == 0) return { index: 0, scanned: 0 };
    if (n == 0 && p == 1) return { index: 1, scanned: 1 };
    let c = 0, i = 0, m = n;
    for (c = 0; n > 0 && p > c; n = n >>> 1) {
        // increment c when nth lsb (bit) is 0
        c = c + (n < (n ^ 0x1)) ? 1 : 0;
        i += 1;
    }
    //log.d("      ", String.fromCharCode(m).charCodeAt(0).toString(2), m, i, p, c);
    return { index: (p == c) ? i : 0, scanned: i };
}

BitString.prototype = {
    init: function (str) {
        this.bytes = str;
        this.length = this.bytes.length * W;
        // trie#flag/value-node uses "string bytes", ref: trie#levelorder
        this.useBuffer = typeof (str) !== "string";
    },

    /**
     * Returns the internal string of bytes
     */
    getData: function () {
        return this.bytes;
    },

    /**
     * Return an array of decimal values, one for every n bits.
     */
    encode: function (n) {
        let e = [];
        for (let i = 0; i < this.length; i += n) {
            e.push(this.get(i, Math.min(this.length, n)));
        }
        return e;
    },

    /**
     * Returns a decimal number, consisting of a certain number of bits (n)
     * starting at a certain position, p.
     */
    get: function (p, n) {
        // supports n <= 31, since bitwise operations works only on +ve integers in js
        if (this.useBuffer) {
            if ((p % W) + n <= W) {
                // case 1: bits lie within the given byte
                return (this.bytes[p / W | 0] & BitString.MaskTop[W][p % W]) >> (W - (p % W) - n);
            } else {
                // case 2: bits lie incompletely in the given byte
                let result = (this.bytes[p / W | 0] & BitString.MaskTop[W][p % W]);

                let l = W - p % W;
                p += l;
                n -= l;

                while (n >= W) {
                    result = (result << W) | this.bytes[p / W | 0];
                    p += W;
                    n -= W;
                }

                if (n > 0) {
                    result = (result << n) | (this.bytes[p / W | 0] >> (W - n));
                }

                return result;
            }
        }

        if ((p % W) + n <= W) {
            // case 1: bits lie within the given byte
            return (DEC(this.bytes[p / W | 0]) & BitString.MaskTop[W][p % W]) >>
                (W - (p % W) - n);
        } else {
            // case 2: bits lie incompletely in the given byte
            let result = (DEC(this.bytes[p / W | 0]) &
                BitString.MaskTop[W][p % W]);

            let l = W - p % W;
            p += l;
            n -= l;

            while (n >= W) {
                result = (result << W) | DEC(this.bytes[p / W | 0]);
                p += W;
                n -= W;
            }

            if (n > 0) {
                result = (result << n) | (DEC(this.bytes[p / W | 0]) >>
                    (W - n));
            }

            return result;
        }
    },

    /**
     * Counts the number of bits set to 1 starting at position p and
     * ending at position p + n
     */
    count: function (p, n) {
        let count = 0;
        while (n >= 16) {
            count += BitsSetTable256[this.get(p, 16)];
            p += 16;
            n -= 16;
        }

        return count + BitsSetTable256[this.get(p, n)];
    },

    /**
     * Returns the index of the nth 0, starting at position i.
     */
    pos0: function (i, n) {
        if (n < 0) return 0;
        let step = 16;
        let index = i;

        if (config.fastPos === false) {
            while (n > 0) {
                step = (n <= 16) ? n : 16;
                const bits0 = step - countSetBits(this.get(i, step));
                if (config.debug) log.d(i + ":i, step:" + step + " get: " + this.get(i,step) + " n: " + n);
                n -= bits0;
                i += step;
                index = i - 1;
            }
            return index;
        }

        while (n > 0) {
            const d = this.get(i, step);
            const bits0 = step - countSetBits(d);
            if (config.debug) log.d(i + ":i, step:" + step + " get: " + this.get(i,step) + " n: " + n);

            if (n - bits0 < 0) {
                step = Math.max(n, step / 2 | 0);
                continue;
            }
            n -= bits0;
            i += step;
            const diff = (n === 0) ? bit0(d, 1, step) : 1;
            index = i - diff;
        }

        return index;
    },

    /**
     * Returns the number of bits set to 1 up to and including position x.
     * This is the slow implementation used for testing.
     */
    rank: function (x) {
        let rank = 0;
        for (let i = 0; i <= x; i++) {
            if (this.get(i, 1)) {
                rank++;
            }
        }
        return rank;
    }
};

/**
 * The rank directory allows you to build an index to quickly compute the rank
 * and select functions. The index can itself be encoded as a binary string.
 */
function RankDirectory(directoryData, bitData, numBits, l1Size, l2Size) {
    this.init(directoryData, bitData, numBits, l1Size, l2Size);
}

/**
 * Builds a rank directory from the given input string.
 *
 * @param data string containing the data, readable using the BitString obj.
 *
 * @param numBits number(letters) in the trie.
 *
 * @param l1Size number(bits) that each entry in the Level1 table
 * summarizes. This should be a multiple of l2Size.
 *
 * @param l2Size number(bits) that each entry in the Level2 table summarizes.
 */
RankDirectory.Create = function (data, nodeCount, l1Size, l2Size) {
    let bits = new BitString(data);
    let p = 0;
    let i = 0;
    let count1 = 0, count2 = 0;

    let numBits = nodeCount * 2 + 1;

    let l1bits = Math.ceil(Math.log2(numBits));
    let l2bits = Math.ceil(Math.log2(l1Size));

    let directory = new BitWriter();

    if (config.selectsearch === false) {
        while (p + l2Size <= numBits) {
            count2 += bits.count(p, l2Size);
            i += l2Size;
            p += l2Size;
            if (i === l1Size) {
                count1 += count2;
                directory.write(count1, l1bits);
                count2 = 0;
                i = 0;
            } else {
                directory.write(count2, l2bits);
            }
        }
    } else {
        let i = 0;
        while (i + l2Size <= numBits) {
            // find index of l2Size-th 0 from index i
            const sel = bits.pos0(i, l2Size);
            // do we need to write l1bits for sel? yes.
            // sel is the exact index of l2size-th 0 in the rankdirectory.
            // todo: impl a l1/l2 cache to lessen nof bits.
            directory.write(sel, l1bits);
            i = sel + 1;
        }
    }

    return new RankDirectory(directory.getData(), data, numBits, l1Size, l2Size);
};

RankDirectory.prototype = {

    init: function (directoryData, trieData, numBits, l1Size, l2Size) {
        this.directory = new BitString(directoryData);
        this.data = new BitString(trieData);
        this.l1Size = l1Size;
        this.l2Size = l2Size;
        this.l1Bits = Math.ceil(Math.log2(numBits));
        this.l2Bits = Math.ceil(Math.log2(l1Size));
        this.sectionBits = (l1Size / l2Size - 1) * this.l2Bits + this.l1Bits;
        this.numBits = numBits;
    },

    /**
     * Returns the string representation of the directory.
     */
    getData: function () {
        return this.directory.getData();
    },

    /**
     * Returns the number of 1 or 0 bits (depending on the "which" parameter)
     * up to and including position x.
     */
    rank: function (which, x) {
        // fixme: selectsearch doesn't work when which === 1, throw error?
        // or, impl a proper O(1) select instead of the current gross hack.
        if (config.selectsearch) {
            let rank = -1;
            let sectionPos = 0;
            const o = x;
            if (x >= this.l2Size) {
                sectionPos = (x / this.l2Size | 0) * this.l1Bits
                rank = this.directory.get(sectionPos - this.l1Bits, this.l1Bits);
                x = x % this.l2Size;
            }
            const ans = (x > 0) ? this.data.pos0(rank + 1, x) : rank;
            if (config.debug) log.d("ans: " + ans + " " + rank + ":r, x: " + x + " " + sectionPos + ":s, o: " + o);
            return ans;
        }

        if (which === 0) {
            return x - this.rank(1, x) + 1;
        }

        let rank = 0;
        let o = x;
        let sectionPos = 0;

        if (o >= this.l1Size) {
            sectionPos = (o / this.l1Size | 0) * this.sectionBits;
            rank = this.directory.get(sectionPos - this.l1Bits, this.l1Bits);
            if (config.debug) log.d("o: " + rank + " sec: " + sectionPos)
            o = o % this.l1Size;
        }

        if (o >= this.l2Size) {
            sectionPos += (o / this.l2Size | 0) * this.l2Bits;
            rank += this.directory.get(sectionPos - this.l2Bits, this.l2Bits);
            if (config.debug) log.d("o2: " + rank + " sec: " + sectionPos)
        }

        rank += this.data.count(x - x % this.l2Size, x % this.l2Size + 1);

        if (config.debug) log.d("ans: " + rank + " x: " + o + " " + sectionPos + ":s, o: " + x);

        return rank;
    },

    /**
     * Returns the position of the y'th 0 or 1 bit, depending on "which" param.
     */
    select: function (which, y) {
        let high = this.numBits;
        let low = -1;
        let val = -1;
        let iter = 0;

        // todo: assert y less than numBits
        if (config.selectsearch) {
            return this.rank(0, y);
        }

        while (high - low > 1) {
            let probe = (high + low) / 2 | 0;
            let r = this.rank(which, probe);
            iter += 1

            if (r === y) {
                // We have to continue searching after we have found it,
                // because we want the _first_ occurrence.
                val = probe;
                high = probe;
            } else if (r < y) {
                low = probe;
            } else {
                high = probe;
            }
        }

        return val;
    }
};

/**
 * A Trie node, for building the encoding trie. Not needed for the decoder.
 */
function TrieNode(letter) {
    this.letter = letter;
    // see: upsertFlag and config.optflags
    // TODO: remove the need for optletter
    this.optletter = null;
    this.final = false;
    this.children = [];
    this.compressed = false;
    this.flag = false;
}

TrieNode.prototype = {
    scale: function() {
        // capture size and len before scaling down this node
        this.size = childrenSize(this);
        this.len = this.children.length;
        this.letter = this.letter[this.letter.length - 1];
        this.children.length = 0;
        this.children = undefined;
        this.optletter = null;
    },
}

// FIXME: eliminate trienode2, handle children being undefined with trienode1
function TrieNode2(letter) {
    this.letter = letter;
    this.compressed = false;
    this.final = false;
    this.children = undefined;
    this.flag = undefined;

    this.scale = function() {
        // no-op
    }
}

function Trie() {
    this.init();
}

Trie.prototype = {
    init: function () {
        this.previousWord = "";
        this.root = new TrieNode([-1]); // any letter would do nicely
        this.cache = [this.root];
        this.nodeCount = 1;
        this.stats = {};
        this.inspect = {};
        this.flags = {};
        this.rflags = {};
        this.fsize = 0;
    },

    /**
     * Returns the number of nodes in the trie
     */
    getNodeCount: function () {
        return this.nodeCount;
    },

    getFlagNodeIfExists(children) {
        if (children && children.length > 0) {
            const flagNode = children[0];
            if (flagNode.flag === true) return flagNode;
        }
        return null;
    },

    setupFlags: function (flags) {
        let i = 0;
        for (const f of flags) {
            // TODO: use gtag/gflag, rm flags and rflags from trie
            // maps ele 'f' to value 'i' (number)
            this.flags[f] = i;
            // maps value 'i' to ele 'f' (str/number)
            this.rflags[i] = f;
            gflag[f] = i;
            gtag[i] = f;
            i += 1;
        }
        // controls number of 16-bit sloted storage for a final trie-node flag.
        // The +1 is reserved for a 16-bit header. This val must be >=2 and <=16.
        this.fsize = Math.ceil(Math.log2(flags.length) / 16) + 1;
    },

    flagToTag: function (flags) {
        // flags has to be an array of 16-bit integers.
        const header = flags[0];
        const tagIndices = [];
        const values = []
        for (let i = 0, mask = 0x8000; i < 16; i++) {
            if ((header << i) === 0) break;
            if ((header & mask) === mask) {
                tagIndices.push(i);
            }
            mask = mask >>> 1;
        }
        // flags.length must be equal to tagIndices.length
        if (tagIndices.length !== flags.length - 1) {
            log.e(tagIndices, flags, " flags and header mismatch (bug in upsert?)");
            return values;
        }
        for (let i = 0; i < flags.length; i++) {
            const flag = flags[i + 1];
            const index = tagIndices[i]
            for (let j = 0, mask = 0x8000; j < 16; j++) {
                if ((flag << j) === 0) break;
                if ((flag & mask) === mask) {
                    const pos = (index * 16) + j;
                    if (config.debug) log.d("pos ", pos, "index/tagIndices", index, tagIndices, "j/i", j, i);
                    values.push(this.rflags[pos]);
                }
                mask = mask >>> 1;
            }
        }
        return values;
    },

    /*
     * Each blocklist gets assigned an ordinal value. That is, they're assigned
     * a integer value, starting from 0. These assigned values are immutable,
     * and never change for a given version.
     *
     * These integer values are then used to encode a user's preference in a
     * (two-level) bit-map. The URL stamp max.rethinkdns.com/1:APD_______8A_A
     * is a base64 of that bit-map (1: is the version; that is, version 1).
     *
     * So, consider blocklists: BA, BB, BC, BD, BE, BF, BG, BH
     *
     * Let's assign ordinal values:
     * BA -> 0
     * BB -> 1
     * BC -> 2
     * ....
     * BG -> 6
     * BH -> 7
     *
     * One can represent all possible grouping (combinations) of these
     * blocklists in a (one-level) bit-map of size 8, that is, with 8 bits.
     *
     * (The following is an example of a big-eindian one-level bit-map)
     * 1000 0000 => means BA (at 0) was selected.
     * 0010 1000 => means BC (at 3) and BE (at 5) were selected.
     * 1111 1110 => means every list except BH (at 7) were selected.
     *
     * A two-level bit-map is an optimization.
     *
     * The first-level determines a selected blocklist group (Gx) while
     * the second-level determines the actual blocklist (Bx).
     *
     * For ex, in the above example, let me divide the blocklists into
     * two equal groups:
     *   G1              G2
     *  BA 0            BE 0
     *  BB 1            BF 1
     *  BC 2            BG 2
     *  BD 3            BH 3
     *
     * where,
     * G1 is 0
     * G2 is 1
     * 
     * So now,
     * The first-level of the bit-map denotes a group: G1 or G2, or both. And
     * the second-level selects a blocklist within that group. We need 2 bits
     * to represent all combinations of groups, G1 and G2.
     *
     * We need 4 bits for blocklists in each group:
     *
     * 10 0001 => means, in G1, select BD (at 3)
     * 11 0010 1100 => means, in G1 select BC (at 2),
     * and in G2 select BE (at 0) and BF (at 1).
     * 01 0001 => means, in G2 select BH (at 3).
     *
     * The first two-bits denote the groups, following them, each group of
     * 4 bits denote the blocklists in those groups.
     *
     * The advantage with a two-level bit-map is, if a user doesn't select
     * any blocklist within a group, I only need one bit to denote that.
     * This is important as RethinkDNS has upwards of 170 blocklists to
     * support, but a user is unlikely to select most of those.
     *
     * One can do better than this, of course. The reason we chose a two-level
     * bit-map was because it allows for fast Set operations (intersection,
     * union, difference) in O(1).
     *
     * One of the simpler ways to avoid this complication of using a bit-map is
     * to simply use one of the available integer compression libraries and use
     * it to compress integer representation of a user's blocklist selection. 
     *
     * A better technique for version 2 perhapse but that may never come to
     * pass: dreamsongs.com/RiseOfWorseIsBetter.html
     */
    upsertFlag: function (node, encodedFlag) {
        let newlyAdded = false;
        const first = node.children[0];
        const isNodeFlag = (first && first.flag);

        if (!encodedFlag || encodedFlag.length === 0) {
            // nothing to do, since there's no flag-node to remove
            if (!isNodeFlag) return;
            // flag-node is present, so slice it out
            node.children = node.children.slice(1);
            node.flag = false;
            // bitslen / encoding type affects nodecount; depending
            // which a flag node is 8bits or 6bits long. see level order
            if (config.optflags && first.optletter != null) {
                this.nodeCount -= Math.ceil(first.optletter.length * 8 / TxtEnc.typ);
            } else {
                this.nodeCount -= Math.ceil(first.letter.length * 16 / TxtEnc.typ);
            }
            return;
        }

        let flag = TxtDec.decode(encodedFlag);
        const val = this.flags[flag];
        if (val == null) {
            log.w(flag, encodedFlag, "<- flags, val undef for node", node);
            throw new Error("val undefined err");
        }

        const flagNode = (isNodeFlag) ? first : new TrieNode(CHR16(0));
        // if flag-node doesn't exist, add it at index 0
        if (!isNodeFlag) {
            flagNode.flag = true;
            const all = node.children;
            node.children = [flagNode]; // index 0
            node.children.concat(all);
            if (config.optflags) flagNode.optletter = [val];
            newlyAdded = true;
        }

        const fnode = flagNode;
        let res = fnode.letter;
        let fopt = fnode.optletter;

        const resnodesize = (!newlyAdded) ? Math.ceil(res.length * 16 / TxtEnc.typ) : 0;
        const optnodesize = (!newlyAdded && fopt) ? Math.ceil(fopt.length * 8 / TxtEnc.typ) : 0;

        if (!newlyAdded && config.optflags) {
            // maintain upto 3 flags as-is, if more, then wipe 'em out
            if (fopt.length < 3) {
                flagNode.optletter.push(val);
            } else {
                flagNode.optletter = null;
                fopt = null;
            }
        }

        const header = 0;
        const index = (val / 16) | 0;
        const pos = val % 16;

        let h = DEC16(res[header]);
        // Fetch the actual tail index position in the character string from the
        // compressed information stored in the header.
        let dataIndex = countSetBits(h & BitString.MaskBottom[16][16 - index]) + 1;

        if (config.debug && (typeof(res) === "undefined"  || typeof(res[dataIndex]) === "undefined")) {
            log.d("res/index/h/val/pos/dataindex", res, res[dataIndex], h, val, pos,dataIndex, "fnode/node/flag/let", fnode, node, node.flag, node.letter);
        }

        // set n to either existing value or create a 0'd string
        let n = -1
        try {
            n = (((h >>> (15 - (index))) & 0x1) !== 1) ? 0 : DEC16(res[dataIndex]);
        } catch (e) {
            log.e("res/len/index/h/val/pos/dataindex", res, res.length, res[dataIndex], h, val, pos, dataIndex, "fnode/node/flag/let", fnode, node, node.flag, node.letter)
            throw e;
        }

        const upsertData = (n !== 0);
        h |= 1 << (15 - index);
        n |= 1 << (15 - pos);

        res = CHR16(h) + res.slice(1, dataIndex) + CHR16(n) + res.slice(upsertData ? (dataIndex + 1) : dataIndex);

        // this size is dependent on how the flag node is eventually
        // serialized by TxtEnc, and so calculate its size accordingly
        const newresnodesize = Math.ceil(res.length * 16 / TxtEnc.typ);
        const newoptnodesize = (fopt) ? Math.ceil(fopt.length * 8 / TxtEnc.typ) : 0;

        if (config.optflags && fopt != null) {
            this.nodeCount +=  newoptnodesize - optnodesize;
        } else {
            if (optnodesize > 0) {
                this.nodeCount += newresnodesize - optnodesize;
            } else {
                this.nodeCount += newresnodesize - resnodesize;
            }
        }

        fnode.letter = res;

        if (config.debug) log.d(flag, val, index, pos)
    },

    /**
     * Inserts a word into the trie, call in alphabetical (lexographical) order.
     */
    insert: function (word) {
        const index = word.lastIndexOf(ENC_DELIM[0]);
        if (index <= 0) {
            err = "missing delim in word: " + TxtEnc.decode(word) + ", delim: " + ENC_DELIM[0] + ", encoded: " + word;
            throw new Error(err);
        }
        const encodedFlag = word.slice(index + 1);
        // each letter in word must be 8bits or less.
        // todo: TxtEnc word here?
        word = word.slice(0, index);

        let j = 1;
        let k = 0;
        let p = 0;
        let topped = false;
        while (p < word.length && j < this.cache.length) {
            const cw = this.cache[j];
            let l = 0;
            while (p < word.length && l < cw.letter.length) {
                if (word[p] !== cw.letter[l]) {
                    // todo: replace with break label?
                    topped = true;
                    break;
                }
                p += 1;
                l += 1;
            }
            k = (l > 0) ? l : k;
            j = (l > 0) ? j + 1 : j;
            if (topped) break;
        }

        const w = word.slice(p);
        const pos = j - 1;
        const node = this.cache[pos];
        const letter = node.letter.slice(0, k);

        // splice out everything but root
        if (pos >= 0) {
            this.cache.splice(pos + 1);
        }

        // todo: should we worry about node-type valueNode/flagNode?
        if (letter.length > 0 && letter.length !== node.letter.length) {
            const split = node.letter.slice(letter.length);
            const tn = new TrieNode(split);
            tn.final = node.final;
            // should this line exist in valueNode mode?
            tn.flag = node.flag;
            // assigning children should take care of moving the valueNode/flagNode
            tn.children = node.children;
            //this.nodeCount += 1;
            node.letter = letter;
            node.children = new Array();
            node.children.push(tn);
            node.final = false;
            this.upsertFlag(node, undefined);
            if (config.debug) log.d("split the node newnode/currentnode/split-reason", n, node.letter, w);
        }

        if (w.length === 0) {
            node.final = true;
            this.upsertFlag(node, encodedFlag);
            if (config.debug) log.d("existing node final nl/split-word/letter-match/pfx/in-word", node.letter, w, letter, commonPrefix, word);
        } else {
            if (typeof (node) === "undefined") log.d("second add new-node/in-word/match-letter/parent-node", w, word, letter, searchPos/*, node.letter*/);
            const second = new TrieNode(w);
            second.final = true;
            this.upsertFlag(second, encodedFlag);
            this.nodeCount += w.length;
            node.children.push(second);
            this.cache.push(second);
        }

        // fixme: remove this, not used, may be an incorrect location to set it
        this.previousWord = word;

        return;
    },

    levelorder: function () {
        const loginspect = true;
        let level = [this.root];
        let p = 0;
        let q = 0;
        let ord = [];
        const inspect = {};
        const flstat = [];
        let nbb = 0;

        for (let n = 0; n < level.length; n++) {
            const node = level[n];

            // skip processing flag-nodes in the regular loop,
            // they always are processed in conjuction with the
            // corresponding final-node. todo: not really req
            // since child-len of a flag-node is unapologetically 0.
            if (node.flag === true) continue;
            // todo: skip aux nodes

            // a node may not have children, but may have a flagNode / valueNode
            // which is always at index 0 of the node.children array
            const childrenLength = (node.children) ? node.children.length : 0;

            q += childrenLength;
            if (n === p) {
                ord.push(q);
                p = q;
            }

            let start = 0;
            let flen = 0;
            const flagNode = this.getFlagNodeIfExists(node.children);
            // convert flagNode / valueNode to trie children nodes
            if (flagNode) {
                start = 1;
                // fixme: abort when a flag node is marked as such but has no value stored?
                if (typeof (flagNode.letter) === "undefined" || typeof (flagNode) === "undefined") {
                    log.w("flagnode letter undef", flagNode, "node", node);
                }

                // encode flagNode.letter which is a 16-bit js-str
                // encode splits letter into units of 6or8bits (uint)
                let encValue = null;
                if (config.optflags && flagNode.optletter != null) {
                    if (loginspect) inspect["optletter"] = (inspect["optletter"] | 0) + 1;
                    encValue = TxtEnc.encode8(flagNode.optletter);
                } else {
                    const letter = flagNode.letter;
                    if (config.useCodec6) {
                        encValue = TxtEnc.encode16(letter);
                    } else {
                        encValue = new BitString(letter).encode(/*mostly, 8*/TxtEnc.typ);
                    }
                }

                flen = encValue.length;
                for (let i = 0; i < encValue.length; i++) {
                    const l = encValue[i];
                    const aux = new TrieNode2(l);
                    aux.flag = true;
                    level.push(aux);
                }

                if (loginspect && flen > 0) {
                    // count nodes having "flen" no. of children
                    const k1 = "encf_" + flen;
                    inspect[k1] = (inspect[k1] | 0) + 1;
                    let flags = null;
                    if (config.optflags && flagNode.optletter != null) {
                        flags = flagNode.optletter.map(i => gtag[i]);
                     } else {
                        const v = TxtDec.decode16raw(encValue);
                        flags = this.flagToTag(v);
                     }
                    // accumulate the count of number of blocklists
                    // that appear together
                    for (let f of flags) {
                        f += "";
                        for (let g of flags) {
                            g += "";
                            if (flstat[f] == null) flstat[f] = [];
                            flstat[f][g] = (flstat[f][g] | 0) + 1;
                        }
                    }
                    const k2 = "ll_" + flags.length;
                    inspect[k2] = (inspect[k2] | 0) + 1;
                }
                nbb += 1;
            }

            // start iterating after flagNode / valudeNode index, if any
            for (let i = start; i < childrenLength; i++) {
                const current = node.children[i];
                if (config.inspect) {
                    // TODO: figure out what really is the below code tracking...
                    // inspect[current.letter.length] = (inspect[current.letter.length + flen] | 0) + 1;
                }
                // flatten out: one letter each into its own trie-node except
                // the last-letter which holds reference to its children
                for (let j = 0; j < current.letter.length - 1; j++) {
                    const l = current.letter[j];
                    const aux = new TrieNode2(l);
                    aux.compressed = true;
                    level.push(aux);
                }
                // current node represents the last letter
                level.push(current);
            }
            // scale down things trie.encode doesn't need
            node.scale();
        }
        if (loginspect) log.d("inspect level-order", inspect);
        if (loginspect) log.d("inspect flags dist", flstat);
        return { level: level, div: ord };
    },

    /**
     * Encode the trie and all of its nodes in a bit-string.
     */
    encode: function() {

        // b00 -> !final, !compressed, !valueNode
        // b01 -> *final, !compressed, !valueNode
        // b10 -> !final, *compressed, !valueNode
        // b11 -> !final, !compressed, *valueNode
        // the above truth table is so because a single node
        // cannot be both compressed and final, at the same time.
        // why? because the node w/ final-letter never sets the compressed flag.
        // only the first...end-1 letters have the compressed flag set.

        // base32 (legacy) => 5 bits per char, +2 bits node metadata
        // utf8 (new)      => 8 bits per char, +2 bits node metadata
        //                   b00    b32        |  b00     utf
        // final-node     : 0x20 => 001 0 0000 | 0x100 => 0001 0000 0000
        // compressed-node: 0x40 => 010 0 0000 | 0x200 => 0010 0000 0000
        // flag/value-node: 0x60 => 011 0 0000 | 0x300 => 0011 0000 0000
        //                   b00    codec6 / b64
        // final-node     : 0x40 => 01 00 0000
        // compressed-node: 0x80 => 10 00 0000
        // flag/value-node: 0xc0 => 11 00 0000
        const finalMask = (config.useCodec6) ? 0x40 : 0x100;
        const compressedMask = (config.useCodec6) ? 0x80 : 0x200;
        const flagMask = (config.useCodec6) ? 0xc0 : 0x300;

        const all1 = 0xffff_ffff // 1s all 32 bits
        const maxbits = countSetBits(all1) // 32 bits

        // Write the unary encoding of the tree in level order.
        let bits = new BitWriter();
        let chars = []

        // write the entry 0b10 (1 child) for root node
        bits.write(0x02, 2);

        this.stats = { children: 0, flags: 0, single: new Array(256).fill(0) }
        let start = Date.now();

        log.i("levelorder begin:", start);
        log.sys();
        // level-order bloats heap-size by 14G+
        const levelorder = this.levelorder();
        log.i("levelorder end: ", Date.now() - start);
        log.sys();

        this.root = null
        this.cache = null

        if (config.debug && global.gc) {
            // in test runs, a call to gc here takes 15m+
            global.gc();
            log.i("encode: gc");
            log.sys();
        }

        const level = levelorder.level;
        let nbb = 0;

        log.i("levlen", level.length, "nodecount", this.nodeCount, " masks ", compressedMask, flagMask, finalMask);
        if (this.nodeCount !== level.length) {
            log.w("nodecount and len(level) not the same, re-check nodeCount calc in upsertFlag");
        }

        const l10 = level.length / 10 | 0;
        for (let i = 0; i < level.length; i++) {
            const node = level[i];
            // clear out the reference
            level[i] = null;
            const childrenLength = (node.len > 0) ? (node.len | 0) : 0;
            const size = (node.size > 0) ? (node.size | 0) : 0;
            nbb += size

            if (i % l10 == 0) {
                log.i("at encode[i]: " + i);
                // seems to show memory increases of 250M+
                log.sys();
            }
            this.stats.single[childrenLength] += 1;

            // set j lsb bits in int bw
            // each set bit marks one child
            let rem = size
            let j = Math.min(rem, /*32*/ maxbits)
            while (j > 0) {
                const bw = (all1 >>> (/*32*/ maxbits - j));
                bits.write(bw, j);
                rem -= j;
                j = Math.min(rem, maxbits);
            }
            // for (let j = 0; j < size; j++) bits.write(1, 1)
            // write 0 to mark the end of the node's child-size
            bits.write(0, 1);

            let value = node.letter;
            if (node.final) {
                value |= finalMask;
                this.stats.children += 1;
            }
            if (node.compressed) {
                value |= compressedMask;
            }
            if (node.flag === true) {
                value |= flagMask;
                this.stats.flags += 1;
            }
            chars.push(value);
            if (config.inspect) this.inspect[i + "_" + node.letter] = {v: value, l: node.letter, f: node.final, c: node.compressed}
        }
        if (config.inspect) {
            let i = 0;
            for (const [k, v] of Object.entries(this.inspect)) {
                console.log(k, v);
                i += 1;
                if (i > 100) break;
            }
        }
        let elapsed2 = Date.now() - start;

        // Write the data for each node, using 6 bits for node. 1 bit stores
        // the "final" indicator. The other 5 bits store one of the 26 letters
        // of the alphabet.
        start = Date.now();
        // 2 extra bits to denote regular, compressed, final, flag node types
        const extraBit = 2;
        const bitslen = extraBit + TxtEnc.typ;
        log.i('charslen: ' + chars.length + ", bitslen: " + bitslen, " letterstart", bits.top);
        if (((this.nodeCount * 2) + 1) !== bits.top) {
            log.w("letterstart not the same as nodecount*2+1; re-check childrenSize calc");
        }
        let k = 0;
        // the memory allocs driven by level-order & bit-writer above
        // are got rid of by the time we hit this portion of the code
        for (const c of chars) {
            if (k % (chars.length / 10 | 0) == 0) {
                log.i("charslen: " + k);
                log.sys();
            }
            bits.write(c, bitslen);
            k += 1;
        }

        let elapsed = Date.now() - start;
        log.i("size:", nbb, ", flags:", this.stats.flags, ", len:", this.stats.children,
            "\nelapsed.write.keys:", elapsed2, ", elapsed.write.values:", elapsed,
            "\nchildren:", this.stats.single,
            "\ncodec memoized:", TxtEnc.stats());

        return bits.getData();
    }
};

// fixme: move to trie's prototype
// returns the "size" of the trie node in number of bytes.
function childrenSize(tn) {
    let size = 0;

    if (!tn.children) return size;

    for (const c of tn.children) {
        // each letter in c.letter is 1 byte long
        let len = c.letter.length;
        if (c.flag) {
            // nodecount depends on how flag node is encoded:
            // calc length(flag-nodes) bit-string (16bits / char)
            // ie, a single letter of a flag node is either 2 bytes
            // long (longer length flags) or 1 byte (shorter length)
            // and these bytes are either represented as in groups
            // of 8bits or 6bits (depending on TxtEnc.typ) in a uint8
            if (config.optflags && c.optletter != null) {
                const optlen = c.optletter.length;
                len = Math.ceil(optlen * 8 / TxtEnc.typ);
            } else {
                len = Math.ceil(len * 16 / TxtEnc.typ);
            }
        }
        size += len;
    }
    return size;
}

/**
 * This class is used for traversing the succinctly encoded trie.
 */
function FrozenTrieNode(trie, index) {
    this.trie = trie;
    this.index = index;

    let finCached, whCached, comCached, fcCached, chCached, valCached, flagCached;
    this.final = () => {
        if (typeof (finCached) === "undefined") {
            finCached = this.trie.data.get(this.trie.letterStart + (this.index * this.trie.bitslen) + 1, 1) === 1;
        }
        return finCached;
    }
    this.where = () => {
        if (typeof (whCached) === "undefined") {
            whCached = this.trie.data.get(this.trie.letterStart + (this.index * this.trie.bitslen) + this.trie.extraBit, this.trie.bitslen - this.trie.extraBit);
        }
        return whCached;
    }
    this.compressed = () => {
        if (typeof (comCached) === "undefined") {
            comCached = (this.trie.data.get(this.trie.letterStart + (this.index * this.trie.bitslen), 1)) === 1;
        }
        return comCached;
    }
    this.flag = () => {
        if (typeof (flagCached) === "undefined") {
            flagCached = this.compressed() && this.final();
        }
        return flagCached;
    }

    this.letter = () => this.where();

    this.firstChild = () => {
        if (!fcCached) {
            fcCached = this.trie.directory.select(0, this.index + 1) - this.index;
        }
        return fcCached;
    }

    if (config.debug) {
        log.d(this.index + " :i, fc: " + this.firstChild() + " tl: " + this.letter() +
                " c: " + this.compressed() + " f: " + this.final() + " wh: " + this.where() +
                " flag: " + this.flag());
    }

    // Since the nodes are in level order, this nodes children must go up
    // until the next node's children start.
    this.childOfNextNode = () => {
        if (!chCached) {
            chCached = this.trie.directory.select(0, this.index + 2) - this.index - 1;
        }
        return chCached;
    }

    this.childCount = () => this.childOfNextNode() - this.firstChild();

    this.value = () => {

            if (typeof (valCached) === "undefined") {
                const childcount = this.childCount();
                const value = [];
                const optvalue = [];
                let i = 0;
                let j = 0;
                if (config.debug) log.d("thisnode: index/vc/ccount ", this.index, this.letter(), childcount)
                // value-nodes are all children from 0...node.flag() is false
                while (i < childcount) {
                    const valueChain = this.getChild(i);
                    if (config.debug) log.d("vc no-flag end vlet/vflag/vindex/val ", i, valueChain.letter(), valueChain.flag(), valueChain.index, value)
                    if (!valueChain.flag()) {
                        break;
                    }
                    if (config.optflags) {
                        optvalue.push(valueChain.letter());
                    }
                    if (config.useCodec6) {
                        // retrieve letter (6 bits) as-is
                        value.push(valueChain.letter());
                        j += 1;
                    } else {
                        // retrieve letter and big-endian it in a bit-string (16 bits)
                        if (i % 2 === 0) {
                            value.push(valueChain.letter() << 8);
                        } else {
                            value[j] = (value[j] | valueChain.letter());
                            j += 1;
                        }
                    }
                    i += 1;
                }
                // maximum number of flags stored as-is is 3.
                // for codec b6 (6 bits), max is len 4 (8*3/6 bits each)
                // for codec b8 (8 bits), max is len 3 (8*3/8 bits each)
                if (config.optflags && optvalue.length <= 4) {
                    // note: decode8 is a no-op for codec typ b8
                    const u8 = (config.useCodec6) ? TxtDec.decode8(optvalue) : optvalue;
                    const fl = new Array(u8.length);
                    u8.forEach((u, i) => fl[i] = gtag[u]);
                    const tt = tagToFlag(fl);
                    valCached = codec.str2buf(tt);
                    if (config.debug) log.d("buf", valCached, "tag", tt, "flag", fl);
                    if (config.debug) log.d("enc u8", u8, "dec u6", optvalue);
                } else {
                    valCached = (config.useCodec6) ? TxtDec.decode16raw(value) : value;
                }
            }

            return valCached;
        }
}

FrozenTrieNode.prototype = {
    /**
     * Returns the number of children.
     */
    getChildCount: function () {
        return this.childCount();
    },

    /**
     * Returns the FrozenTrieNode for the given child.
     *
     * @param index The 0-based index of the child of this node. For example, if
     * the node has 5 children, and you wanted the 0th one, pass in 0.
     */
    getChild: function (index) {
        return this.trie.getNodeByIndex(this.firstChild() + index);
    },
};

/**
 * The FrozenTrie is used for looking up words in the encoded trie.
 *
 * @param data A string representing the encoded trie.
 *
 * @param directoryData A string representing the RankDirectory. The global L1
 * and L2 constants are used to determine the L1Size and L2size.
 *
 * @param nodeCount The number of nodes in the trie.
 */
function FrozenTrie(data, rdir, nodeCount) {
    this.init(data, rdir, nodeCount);
}

FrozenTrie.prototype = {
    init: function (trieData, rdir, nodeCount) {
        this.data = new BitString(trieData);
        // pass the rank directory instead of data
        this.directory = rdir;

        this.extraBit = 2;
        this.bitslen = TxtEnc.typ + this.extraBit;

        // The position of the first bit of the data in 0th node. In non-root
        // nodes, this would contain bitslen letters.
        this.letterStart = nodeCount * 2 + 1;
    },

    /**
     * Retrieve the FrozenTrieNode of the trie, given its index in level-order.
     * This is a private function that you don't have to use.
     */
    getNodeByIndex: function (index) {
        // todo: index less than letterStart?
        return new FrozenTrieNode(this, index);
    },

    /**
     * Retrieve the root node. You can use this node to obtain all of the other
     * nodes in the trie.
     */
    getRoot: function () {
        return this.getNodeByIndex(0);
    },

    /**
     * Look-up a word in the trie. Returns true if and only if the word exists
     * in the trie.
     */
    lookup: function (word) {
        const index = word.lastIndexOf(ENC_DELIM[0]);
        if (index > 0) word = word.slice(0, index); //: word.slice(index + 1)
        const debug = config.debug;
        let node = this.getRoot();
        let child;
        // return false when lookup fails, or a Map when it succeeds... yeah
        let returnValue = false
        for (let i = 0; i < word.length; i++) {
            let isFlag = -1;
            let that;
            // capture all valid subdomains
            if (periodEncVal[0] == word[i]) {
                if (node.final()) {
                    if (returnValue == false) { returnValue = new Map() }
                    returnValue.set(TxtDec.decode(word.slice(0, i).reverse()), node.value())
                }
            }
            // count actual child nodes, except the key/flag/value-node which
            // appears always at the head end (index 0) of children nodes
            do {
                that = node.getChild(isFlag + 1);
                if (!that.flag()) break;
                isFlag += 1;
            } while (isFlag + 1 < node.getChildCount());

            const minChild = isFlag;
            if (debug) log.d("            count: " + node.getChildCount() + " i: " + i + " w: " + word[i] + " nl: " + node.letter() + " flag: " + isFlag)

            if ((node.getChildCount() - 1) <= minChild) {
                if (debug) log.d("  no more children left, remaining word: " + word.slice(i));
                // fixme: fix these return false to match the actual return value?
                return returnValue;
            }
            // linear search is simpler but very very slow
            if (config.useBinarySearch === false) {
                let j = minChild;
                for (; j < node.getChildCount(); j++) {
                    child = node.getChild(j);
                    if (debug) log.d("it: " + j + " tl: " + child.letter() + " wl: " + word[i])
                    if (child.letter() == word[i]) {
                        if (debug) log.d("it: " + j + " break ")
                        break;
                    }
                }

                if (j === node.getChildCount()) {
                    if (debug) log.d("j: " + j + " c: " + node.getChildCount())
                    return returnValue;
                }
            } else {
                // search current letter w/ binary-search among child nodes
                let high = node.getChildCount();
                let low = minChild;

                while (high - low > 1) {
                    let probe = (high + low) / 2 | 0;
                    child = node.getChild(probe);
                    const prevchild = (probe > isFlag) ? node.getChild(probe - 1) : undefined;
                    if (debug) log.d("        current: " + child.letter() + " l: " + low + " h: " + high + " w: " + word[i])

                    // if the current probe position is at a compressed node,
                    // check if its sibling is also a compressed node to then
                    // search for all letters represented by compressed nodes,
                    // in a single go.
                    if (child.compressed() || (prevchild && (prevchild.compressed() && !prevchild.flag()))) {

                        let startchild = [];
                        let endchild = [];
                        let start = 0;
                        let end = 0;

                        startchild.push(child);
                        start += 1;

                        // startchild len > word len terminate
                        // fixme: startchild first letter != w first letter terminate
                        do {
                            const temp = node.getChild(probe - start);
                            if (!temp.compressed()) break;
                            if (temp.flag()) break;
                            startchild.push(temp);
                            start += 1;
                        } while (true);

                        // if first letter (startchild is reversed, and so: last letter)
                        // is greater than current letter from word, then probe lower half
                        if (debug) log.d("  check: letter : "+startchild[start - 1].letter()+" word : "+word[i]+" start: "+start);
                        if (startchild[start - 1].letter() > word[i]) {
                            if (debug) log.d("        shrinkh start: " + startchild[start - 1].letter() + " s: " + start + " w: " + word[i]);

                            high = probe - start + 1;
                            if (high - low <= 1) {
                                if (debug) log.d("...h-low: " + (high - low) + " c: " + node.getChildCount(), high, low, child.letter(), word[i], probe);
                                return returnValue;
                            }
                            continue;
                        }

                        // if the child itself the last-node in the seq
                        // nothing to do, there's no endchild to track
                        if (child.compressed()) { // compressed, not final
                            do {
                                end += 1;
                                const temp = node.getChild(probe + end);
                                endchild.push(temp);
                                if (!temp.compressed()) break;
                                // cannot encounter a flag whilst probing higher indices
                                // since flag is always at index 0.
                            } while (true);
                        }

                        // if first letter (startchild is reversed, so: last letter)
                        // is lesser than current letter from word, then probe higher
                        if (startchild[start - 1].letter() < word[i]) {
                            if (debug) log.d("        shrinkl start: " + startchild[start - 1].letter() + " s: " + start + " w: " + word[i]);

                            low = probe + end;

                            if (high - low <= 1) {
                                if (debug) log.d("...h-low: " + (high - low) + " c: " + node.getChildCount(), high, low, child.letter(), word[i], probe);
                                return returnValue;
                            }
                            continue;
                        }

                        const nodes = startchild.reverse().concat(endchild);
                        let comp = nodes.map(n => n.letter());
                        const w = word.slice(i, i + comp.length);

                        if (debug) log.d("it: " + probe + " tl: " + comp + " wl: " + w + " c: " + child.letter());

                        if (w.length < comp.length) return returnValue;
                        for (let i = 0; i < comp.length; i++) {
                            if (w[i] !== comp[i]) return returnValue;
                        }

                        if (debug) log.d("it: " + probe + " break ")

                        // final letter in compressed node is representative of all letters
                        // that is, compressednode("abcd") is represented by final node("d")
                        child = nodes[nodes.length - 1];
                        i += comp.length - 1; // ugly compensate i++ at the top
                        break;
                    } else {
                        if (child.letter() === word[i]) {
                          break;
                        } else if (word[i] > child.letter()) {
                          low = probe;
                        } else {
                          high = probe;
                        }
                    }

                    if (high - low <= 1) {
                        if (debug) log.d("h-low: " + (high - low) + " c: " + node.getChildCount(), high, low, child.letter(), word[i], probe)
                        return returnValue;
                    }
                }
            }

            if (debug) log.d("        next: " + child.letter());

            node = child;
        }

        // using node.index, find value in rd.data after letterStart + (bitslen * nodeCount) + 1
        // level order indexing, fixme: see above re returning "false" vs [false] vs [[0], false]
        //return (node.final()) ? [node.value(), node.final()] : node.final();
        if (node.final()) {
            if (returnValue == false) { returnValue = new Map(); }
            returnValue.set(TxtDec.decode(word.reverse()), node.value());
        }
        return returnValue;
    }
};

function lex(a, b) {
    const n = Math.min(a.length, b.length);
    const lendiff = a.length - b.length;
    if (n === 0) return lendiff;
    for (let i = 0; i < n; i++) {
        const d = a[i] - b[i];
        if (d === 0) continue;
        return d;
    }
    return lendiff;
}

function tagToFlag(fl) {
    const debug = false;
    let res = CHR16(0);

    for (let flag of fl) {
        let val = gflag[flag]; // .value
        const header = 0;
        const index = ((val / 16) | 0);
        const pos = val % 16;
        if (debug) log.d("val:", val, " flag:", flag/*, " tag:", ftags[flag]*/);

        let h = DEC16(res[header]);

        if (debug) log.d("mask:", (BitString.MaskBottom[16][16 - index]).toString(16).padStart(4, 0),
                        "h start:", (h).toString(16).padStart(4, 0),
                        " countbit:", countSetBits(h & BitString.MaskBottom[16][16 - index]));
        let dataIndex = countSetBits(h & BitString.MaskBottom[16][16 - index]) + 1;
        let n = (((h >>> (15 - (index))) & 0x1) !== 1) ? 0 : DEC16(res[dataIndex]);
        const upsertData = (n !== 0);
        h |= 1 << (15 - index);
        n |= 1 << (15 - pos);

        res = CHR16(h) + res.slice(1, dataIndex) + CHR16(n) + res.slice(upsertData ? (dataIndex + 1) : dataIndex);
        if (debug) {
            let hexres = "";
            for(let r of res) {
                hexres += (DEC16(r)).toString(16).padStart(4, 0) + " ";
            }
            log.d("h:", (h).toString(16).padStart(4, 0), "r: ", hexres, " n:", (n).toString(16).padStart(4, 0), " dataIndex:", dataIndex, " index:", index, " pos:", pos);
        }
    }
    if (debug) log.d(res);
    return res;
}

async function build(blocklist, filesystem, savelocation, tag_dict) {

    // in key:value pair, key cannot be anything that coerces to boolean false
    let tag = {};
    let fl = [];
    for (let ele in tag_dict) {
        if (!tag_dict.hasOwnProperty(ele)) continue;
        // value is always a number
        fl[tag_dict[ele].value] = ele;
        // reverse the value since it is prepended to the front of key
        // uname is, for most lists, equal to string(tag_dict[ele].value)
        const v = codec.delim + tag_dict[ele].uname;
        // ele may be a number, may be a string (older)
        tag[ele] = v.split("").reverse().join("");
    }
    initialize();

    let t = new Trie();
    t.setupFlags(fl);
    if (config.debug) log.d("gtag (i=>str)", gtag, "\n", "gflag (str=>i)", gflag);

    let hosts = [];
    try {
        let totalfiles = 0;
        let totallines = 0;
        for (let filepath of blocklist) {
            let patharr = filepath.split("/");
            // fname is same as tag_dict's uname
            let fname = patharr[patharr.length - 1].split(".")[0];
            let f = filesystem.readFileSync(filepath, 'utf8');
            if (f.length <= 0) {
                log.i("empty file", filepath);
                continue;
            }
            if (config.debug) {
                log.d("adding: " + filepath, fname + " <-file | tag-> "+tag[fname]);
            }
            let lines = 0;
            for (let h of f.split("\n")) {
                const ht = tag[fname] + h.trim();
                const htr = TxtEnc.encode(ht).reverse();
                hosts.push(htr);
                lines += 1;
            }
            totallines = totallines + lines;
            tag_dict[fname].entries = lines;
            totalfiles += 1;
        }
        log.i("Lines: " + totallines, "Files: " + totalfiles);
    } catch (e) {
        log.e(e);
        throw e;
    }

    // if sorting isn't lexographical, trie.insert would not work, resulting
    // in broken search / lookups; this also shows up highlighting disparity
    // between trie.nodecount and no of nodes traversed by trie.levelorder
    hosts.sort(lex);

    const start = Date.now();
    log.i("building trie");
    log.sys();
    hosts.forEach(s => t.insert(s));
    // fast array clear stackoverflow.com/a/1234337
    hosts.length = 0
    hosts = []
    if (global.gc) {
        log.sys();
        log.i("gc");
        global.gc();
    }

    log.i("encoding trie")
    log.sys();
    let td = t.encode();
    const nodeCount = t.getNodeCount();

    log.i("building rank; nodecount/L1/L2", nodeCount, L1, L2)
    let rd = RankDirectory.Create(td, nodeCount, L1, L2);

    let ft = new FrozenTrie(td, rd, nodeCount);
    const end = Date.now();

    log.i("time (ms) spent creating trie+rank: ", end - start);

    log.i("saving trie, rank, basicconfig, filetag");

    if (!filesystem.existsSync(savelocation)) {
        filesystem.mkdirSync(savelocation);
    }

    let aw1 = filesystem.writeFile(savelocation + "td.txt", td, function (err) {
        if (err) {
            log.e(err);
            throw err;
        }
        log.i('trie saved as td.txt');
    });

    let aw2 = filesystem.writeFile(savelocation + "rd.txt", rd.directory.bytes, function (err) {
        if (err) {
            log.e(err);
            throw err;
        }
        log.i('rank saved as rd.txt');
    });

    let basicconfig = { "nodecount" : nodeCount };
    let aw3 = filesystem.writeFile(savelocation + "basicconfig.json", JSON.stringify(basicconfig), function (err) {
        if (err) {
            log.e(err);
            throw err;
        }
        log.i('basicconfig.json saved');
    });

    let aw4 = filesystem.writeFile(savelocation + "filetag.json", JSON.stringify(tag_dict), function (err) {
        if (err) {
            log.e(err);
            throw err;
        }
        log.i('filetag.json saved');
    });

    await Promise.all([aw1, aw2, aw3, aw4]);

    log.sys();
    log.i("Lookup a few domains in this new trie");

    let testdomains = [
            "aws.com",
            "sg-ssl.effectivemeasure.net",
            "staging.connatix.com",
            "ads.redlightcenter.com",
            "oascentral.chicagobusiness.com",
            "simpsonitos.com",
            "putlocker.fyi",
            "segment.io",
            "hearst.gscontxt.net",
            "xnxx.com",
            "google.ae",
            "celzero.com"];
    for (let domainname of testdomains) {
        const ts = TxtEnc.encode(domainname).reverse();
        const sresult = ft.lookup(ts);
        log.i("looking up domain: " + domainname, "result: ");
        if (sresult) {
            for (let [d, value] of sresult) {
                log.i("for", d + ":", t.flagToTag(value));
            }
        } else {
            log.i(domainname, "not found in trie");
        }
    }
}

module.exports.build = build;
