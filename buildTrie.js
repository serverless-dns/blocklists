const BASE64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

let config = {
    // inspect trie building stats
    inspect: false,
    // read and write bit-strings with 16-bit boundaries
    utf16: true,
    // binary-search (not linear) to lookup for words in the forzentrie
    useBinarySearch: true,
    // debug prints debug logs
    debug: false,
    // transforms select ops into rank ops with help of a modified l1/l2 layer
    selectsearch: true,
    // optimize pos0 impl by probing "longer steps" than usual
    fastPos: true,
    // compress converts trie into a radix-trie esque structure
    compress: true,
    // unroll is supersceded by compress
    unroll: false,
    // useBuffer uses js typed-arrays instead of bit-strings
    useBuffer: true,
    // BitWriter packs bits in 16-bit char instead of an array
    write16: true,
    // valueNode encodes "value" of arbitar length in the leafnodes
    valueNode: true,
    // transform all inputs in to / out of trie to base32
    base32: false,
    // unimplemented: store metadata about the trie in the trie itself
    storeMeta: false,
}

if (config.valueNode) {
    // value-node needs the extraBit to be identified as such.
    // b00 -> !final, !compressed, !valueNode
    // b01 -> *final, !compressed, !valueNode
    // b10 -> !final, *compressed, !valueNode
    // b11 -> !final, !compressed, *valueNode
    // the above truth table is so because a single node
    // cannot be both compressed and final, at the same time.
    // why? because the node w/ final-letter never sets the compressed flag.
    // only the first...end-1 letters have the compressed flag set.
    // see: trie-node#encode
    config.compress = true;
}
if (config.compress) {
    config.unroll = false; // not supported
    // compression doesn't support base64 wo unroll, min req is base128
    // min: 5 bits for letter, 1 bit for final flag, 1 bit for compress flag
    config.utf16 = (config.unroll) ? config.utf16 : true;
}
if (config.write16) {
    // write16 only works with array-buffer. see: BitWriter#getData
    config.useBuffer = true;
}

/**
 * Number of bits (width) of each encoding unit; ie 6 => base64.
 */
const W = (config.utf16) ? 16 : (config.utf15) ? 15 : 6;

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
// skip list range for values-directory, store the nearest min index
// of a final-node to a node at every V1 position
const V1 = 64;
// bits per meta-data field stored with trie-encode
const MFIELDBITS = 30;
const TxtEnc = new TextEncoder();
const TxtDec = new TextDecoder();
// DELIM to tag elements in the trie, shouldn't be a valid base32 char
const DELIM = "#";
// utf8 encoded delim for non-base32/64
const ENC_DELIM = TxtEnc.encode(DELIM);
// As ddict approachs 1, better perf at cost of higher memory usage
let DDICT = 50;
// Max unicode char-code of a base32 string (which is 122).
const MAXB32CHARCODE = 127;

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
            console.error("write16 can only writes lsb16 bits, out of range: " + numBits);
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
        console.log("W/size/n ", W, size, n)
        let j = 0;
        let b = 0;
        let i = 0;
        while (j < n) {
            b = (b << 1) | this.bits[j];
            i += 1;
            if (i === W) {
                if (config.useBuffer) {
                    if (config.debug) console.debug("i/j/W/n/s", i, j, W, n, size);
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
        0x0000],
    15: [0x7fff,
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
        0x0000],
    6: [0x003f,
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
    //console.log("      ", String.fromCharCode(m).charCodeAt(0).toString(2), m, i, p, c);
    return { index: (p == c) ? i : 0, scanned: i };
}

BitString.prototype = {
    init: function (str) {
        this.bytes = str;
        this.length = this.bytes.length * W;
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
            // case 1: bits lie within the given byte
            if ((p % W) + n <= W) {
                return (this.bytes[p / W | 0] & BitString.MaskTop[W][p % W]) >> (W - (p % W) - n);

                // case 2: bits lie incompletely in the given byte
            } else {
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
        // case 1: bits lie within the given byte
        if ((p % W) + n <= W) {
            return (DEC(this.bytes[p / W | 0]) & BitString.MaskTop[W][p % W]) >>
                (W - (p % W) - n);

            // case 2: bits lie incompletely in the given byte
        } else {
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
        8if (n < 0) return 0;
        let step = 16;
        let index = i;

        if (config.fastPos === false) {
            while (n > 0) {
                step = (n <= 16) ? n : 16;
                const bits0 = step - countSetBits(this.get(i, step));
                if (config.debug) console.log(i + ":i, step:" + step + " get: " + this.get(i,step) + " n: " + n);
                n -= bits0;
                i += step;
                index = i - 1;
            }
            return index;
        }

        while (n > 0) {
            const d = this.get(i, step);
            const bits0 = step - countSetBits(d);
            if (config.debug) console.log(i + ":i, step:" + step + " get: " + this.get(i,step) + " n: " + n);

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

function nodeCountFromEncodedDataIfExists(bits, defaultValue) {
    if (!config.storeMeta) return defaultValue;

    // fixme: this doesn't work since the the packing is
    // aligned to 16 bits, and there could be padded bits
    // added at the the end that need to be discarded
    return bits.get(bits.length - MFIELDBITS, MFIELDBITS);
}

/**
 * The rank directory allows you to build an index to quickly compute the rank
 * and select functions. The index can itself be encoded as a binary string.
 */
function RankDirectory(directoryData, bitData, numBits, l1Size, l2Size, valueDirData) {
    this.init(directoryData, bitData, numBits, l1Size, l2Size, valueDirData);
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

    nodeCount = nodeCountFromEncodedDataIfExists(bits, nodeCount);

    let numBits = nodeCount * 2 + 1;

    let l1bits = Math.ceil(Math.log2(numBits));
    let l2bits = Math.ceil(Math.log2(l1Size));
    const bitCount = (config.compress && !config.unroll) ? 7 : 6;
    let valuesIndex = numBits + (bitCount * nodeCount);

    let directory = new BitWriter();
    let valueDir = new BitWriter();

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

    const bitslenindex = Math.ceil(Math.log2(nodeCount));
    const bitslenpos = Math.ceil(Math.log2(bits.length - valuesIndex));
    const bitslenvalue = 16;

    // 0th pos is 0.
    valueDir.write(0, bitslenpos);
    let j = 1;
    let insp = []
    for (let i = valuesIndex, b = valuesIndex; (i + bitslenindex + bitslenvalue) < bits.length;) {
        const currentIndex = bits.get(i, bitslenindex);
        if (config.inspect) insp.push(currentIndex);
        const currentValueHeader = bits.get(i + bitslenindex, bitslenvalue);
        // include +1 for the header in currentValueLength
        const currentValueLength = (countSetBits(currentValueHeader) + 1) * bitslenvalue;
        const pos = (currentIndex / V1) | 0;
        // for all positions less than or equal to j, fill it with
        // the previous index, except at pos 0
        while (pos != 0 && pos >= j) {
            b = (pos === j) ? i : b;
            const v = b - valuesIndex;
            valueDir.write(v, bitslenpos);
            j += 1;
            if (config.debug && pos === j) console.debug(j, v, currentIndex);
        }
        i += currentValueLength + bitslenindex;
    }
    if (config.inspect) console.log(insp)

    return new RankDirectory(directory.getData(), data, numBits, l1Size, l2Size, valueDir.getData());
};

RankDirectory.prototype = {

    init: function (directoryData, trieData, numBits, l1Size, l2Size, valueDir) {
        this.directory = new BitString(directoryData);
        if (valueDir) this.valueDir = new BitString(valueDir);
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
            if (config.debug) console.debug("ans: " + ans + " " + rank + ":r, x: " + x + " " + sectionPos + ":s, o: " + o);
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
            if (config.debug) console.debug("o: " + rank + " sec: " + sectionPos)
            o = o % this.l1Size;
        }

        if (o >= this.l2Size) {
            sectionPos += (o / this.l2Size | 0) * this.l2Bits;
            rank += this.directory.get(sectionPos - this.l2Bits, this.l2Bits);
            if (config.debug) console.debug("o2: " + rank + " sec: " + sectionPos)
        }

        rank += this.data.count(x - x % this.l2Size, x % this.l2Size + 1);

        if (config.debug) console.log("ans: " + rank + " x: " + o + " " + sectionPos + ":s, o: " + x);

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
    this.final = false;
    this.children = [];
    this.compressed = false;
    this.flag = (config.valueNode) ? false : undefined;
}

// FIXME: eliminate trienode2, handle children being undefined with trienode1
function TrieNode2(letter) {
    this.letter = letter;
    this.compressed = false;
    this.final = false;
    this.children = undefined;
    this.flag = undefined;
}

function Trie() {
    this.init();
}

Trie.prototype = {
    init: function () {
        this.previousWord = "";
        this.root = (config.base32) ? new TrieNode('0') : new TrieNode([0]); // any letter would do nicely
        this.cache = [this.root];
        this.nodeCount = 1;
        this.invoke = 0;
        this.stats = {};
        this.inspect = {};
        this.flags = {};
        this.rflags = {};
        this.fsize = 0;
        this.indexBitsArray = ["0"];
        this.sset = new Set();
    },


    lookup_check: function (node) {
        let currentnode = this.root.children
        let result = false
        console.log(node)
        for (let ni = 0; ni < node.length; ni++) {
            console.log(node[ni])
            for (let ci = 0; ci < currentnode.length; ci++) {
                if (currentnode[ci].letter[0] == node[ni]) {
                    result = true
                    ni += (currentnode[ci].letter.length - 1)
                    currentnode = currentnode[ci].children
                    break;
                }
            }
            if (!result) {
                break
            }
            result = false
            console.log(currentnode)
        }
        console.log(node)
        if (result || ni == node.length) {
            if (config.debug) console.debug(currentnode, currentnode[0].flag)
            if (currentnode[0].flag) {
                let buf = new ArrayBuffer(currentnode[0].letter.length * 2)
                let u16arr = new Uint16Array(buf)
                for (let si = 0; si < currentnode[0].letter.length; si++) {
                    u16arr[si] = DEC16(currentnode[0].letter[si])
                    if (config.debug) console.debug(currentnode[0].letter[si]+"::"+DEC16(currentnode[0].letter[si]))
                }
                if (config.debug) console.debug("lookup array: " + u16arr, "res: " + this.flagsToTag(u16arr))
                if (config.debug) console.debug(this.flagsToTag(TxtDec.encode(currentnode[0].letter).reverse()))
            }
            if (config.debug) console.debug(node, currentnode)
        } else {
            console.log("Search Result Not found in t")
        }
    },

    /**
     * Returns the number of nodes in the trie
     */
    getNodeCount: function () {
        return this.nodeCount;
    },

    getFlagNodeIfExists(children) {
        if (config.valueNode && children && children.length > 0) {
            const flagNode = children[0];
            if (flagNode.flag === true) return flagNode;
        }
        return undefined;
    },

    setupFlags: function (flags) {
        let i = 0;
        for (f of flags) {
            this.flags[f] = i;
            this.rflags[i] = f;
            i += 1;
        }
        // controls number of 16-bit sloted storage for a final trie-node flag.
        // The +1 is reserved for a 16-bit header. This val must be >=2 and <=16.
        this.fsize = Math.ceil(Math.log2(flags.length) / 16) + 1;
    },

    flagsToTag: function (flags) {
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
            console.error(tagIndices, flags, " flags and header mismatch (bug in upsert?)");
            return values;
        }
        for (let i = 0; i < flags.length; i++) {
            const flag = flags[i + 1];
            const index = tagIndices[i]
            for (let j = 0, mask = 0x8000; j < 16; j++) {
                if ((flag << j) === 0) break;
                if ((flag & mask) === mask) {
                    const pos = (index * 16) + j;
                    if (config.debug) console.log("pos ", pos, "index/tagIndices", index, tagIndices, "j/i", j, i);
                    values.push(this.rflags[pos]);
                }
                mask = mask >>> 1;
            }
        }
        return values;
    },

    upsertFlag: function (node, flag) {
        let res;
        let fnode;
        let val;
        let newlyAdded = false;
        if (config.valueNode === true) {
            const first = node.children[0];
            const isNodeFlag = (first && first.flag);

            if (!flag || flag.length === 0) {
                // nothing to do, since there's no flag-node to remove
                if (!isNodeFlag) return;
                // flag-node is present, so slice it out
                node.children = node.children.slice(1);
                node.flag = false;
                this.nodeCount -= ((config.base32) ? base32.encode(first.letter).length : first.letter.length * 2);
                return;
            }

            if (config.base32 === false) {
                flag = TxtDec.decode(flag);
            }
            val = this.flags[flag];
            //this.sset.add({v: val, f: flag})
            if (typeof (val) === "undefined") {
                console.log("val undef ", node)
                throw "val under Error"
                return;
            }

            const flagNode = (isNodeFlag) ? first : new TrieNode(CHR16(0));
            if (!isNodeFlag) { // if flag-node doesn't exist, add it at index 0.
                const all = node.children;
                node.children = [flagNode];
                node.children.concat(all);
                newlyAdded = true;
            }

            flagNode.flag = true;
            res = flagNode.letter;
            fnode = flagNode;
        } else {
            if (!flag || flag.length === 0) {
                this.nodeCount -= ((config.base32) ? base32.encode(node.flag).length : node.flag.length * 2);
                node.flag = undefined;
                return;
            }

            if (config.base32 === false) {
                flag = TxtDec.decode(flag);
            }
            val = this.flags[flag];
            if (typeof (val) === "undefined") {
                // todo: error out?
                if (config.debug) console.log("val undef ", node)
                return;
            }

            if (typeof (node.flag) === "undefined") {
                node.flag = CHR16(0);
                newlyAdded = true
            }

            res = node.flag;
            fnode = node;
        }

        const header = 0;
        const index = ((val / 16) | 0) // + 1;
        const pos = val % 16;

        const resnodesize = (!newlyAdded) ? ((config.base32) ? base32.encode(res).length : res.length * 2) : 0;

        let h = DEC16(res[header]);
        // Fetch the actual tail index position in the character string from the
        // compressed information stored in the header.
        let dataIndex = countSetBits(h & BitString.MaskBottom[16][16 - index]) + 1;


        if (config.debug && (typeof(res) === "undefined"  || typeof(res[dataIndex]) === "undefined")) {
            console.log("res/index/h/val/pos/dataindex", res, res[dataIndex], h, val, pos,dataIndex, "fnode/node/flag/let", fnode, node, node.flag, node.letter);
        }

        // set n to either existing value or create a 0'd string
        let n = -1
        try {
            n = (((h >>> (15 - (index))) & 0x1) !== 1) ? 0 : DEC16(res[dataIndex]);
        } catch (e) {
            console.log("res/len/index/h/val/pos/dataindex", res, res.length, res[dataIndex], h, val, pos, dataIndex, "fnode/node/flag/let", fnode, node, node.flag, node.letter)
            throw e
        }

        const upsertData = (n !== 0)
        h |= 1 << (15 - index);
        n |= 1 << (15 - pos);

        res = CHR16(h) + res.slice(1, dataIndex) + CHR16(n) + res.slice(upsertData ? (dataIndex + 1) : dataIndex);

        const newresnodesize = ((config.base32) ? base32.encode(res).length : res.length * 2);

        this.nodeCount = this.nodeCount - resnodesize + newresnodesize;

        if (config.valueNode === true) {
            fnode.letter = res;
        } else {
            fnode.flag = res;
        }

        if (config.debug) console.log(flag, val, index, pos)
    },

    /**
     * Inserts a word into the trie, call in alphabetical (lexographical) order.
     */
    insert: function (word) {

        const index = (config.base32) ? word.lastIndexOf(DELIM) : word.lastIndexOf(ENC_DELIM[0]);
        const flag = word.slice(index + 1);
        word = word.slice(0, index);

        if (config.compress === true) {
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
                if (config.debug) console.log("split the node newnode/currentnode/split-reason", n, node.letter, w);
            }

            if (w.length === 0) {
                node.final = true;
                this.upsertFlag(node, flag);
                if (config.debug) console.log("existing node final nl/split-word/letter-match/pfx/in-word", node.letter, w, letter, commonPrefix, word);
            } else {
                if (typeof (node) === "undefined") console.log("second add new-node/in-word/match-letter/parent-node", w, word, letter, searchPos/*, node.letter*/);
                const second = new TrieNode(w);
                second.final = true;
                this.upsertFlag(second, flag)
                this.nodeCount += w.length;
                node.children.push(second);
                this.cache.push(second);
            }

            // todo: remove this, not used, may be an incorrect location to set it
            this.previousWord = word;

            return;
        }

        let commonPrefix = 0;
        let i = 0;
        while (i < Math.min(word.length, this.previousWord.length)) {
            if (word[i] !== this.previousWord[i]) break;
            commonPrefix += 1;
            i += 1;
        }

        this.cache.splice(commonPrefix + 1)
        let node = this.cache[this.cache.length - 1];

        for (i = commonPrefix; i < word.length; i++) {
            // fixes bug if words not inserted in alphabetical order
            // but it is slow, so we do not use it
            /*let isLetterExist = false;
            for ( var j = 0; j < node.children.length; j++ ) {
                if (node.children[j].letter == word[i]) {
                    this.cache.push(node.children[j]);
                    node = node.children[j];
                    isLetterExist = true;
                    break;
                }
            }
            if (isLetterExist) continue;*/

            const next = new TrieNode(word[i]);
            this.nodeCount += 1;
            node.children.push(next);
            this.cache.push(next);
            node = next;
        }

        node.final = true;
        this.upsertFlag(node, flag);
        this.previousWord = word;
    },

    /**
     * Apply a function to each node, traversing the trie in level order.
     */
    apply: function (fn) {
        let level = [this.root];
        while (level.length > 0) {
            let node = level.shift();
            for (let i = 0; i < node.children.length; i++) {
                level.push(node.children[i]);
            }
            fn(this, node);
        }

    },

    levelorder: function () {
        let level = [this.root];
        let p = 0;
        let q = 0;
        let ord = [];
        const inspect = {};
        // unroll superseceded by compress
        // let unrollmap = {};
        let nbb = 0;

        for (let n = 0; n < level.length; n++) {
            const node = level[n];

            // skip processing flag-nodes in the regular loop,
            // they always are processed in conjuction with the
            // corresponding final-node. todo: not really req
            // since child-len of a flag-node is unapologetically 0.
            if (config.valueNode && node.flag === true) continue;

            const childrenLength = (node.children) ? node.children.length : 0;

            // unroll superseceded by compress
            /*const auxChild = unrollmap[node];
            if (auxChild) {
                staging.push(auxChild);
                unrollmap[node] = undefined;
            }*/

            q += childrenLength;
            if (n === p) {
                ord.push(q);
                p = q;
            }
            // unroll superseceded by compress
            /*if (config.unroll) {
                for (let i = 0; i < childrenLength; i++) {
                    const current = node.children[i];
                    let ansector = current;
                    // if current node is compressed, its children must be transferred to the
                    // last element in the compressed letters list.
                    const currentChildren = current.children;
                    for (let j = 1; j < current.letter.length; j++) {
                        const l = current.letter[j]
                        const aux = new TrieNode2(l)
                        //aux.compressed = true
                        //unrollmap[ansector] = aux;
                        // assign aux as a child to ansector
                        ansector.children = [aux];
                        ansector = aux;
                    }
                    if (current.compressed) {
                        ansector.final = current.final;
                        // assign current.children to last ancestor
                        ansector.children = current.children;
                        current.children = [;
                        current.final = false;
                    }
                    // current represents the first letter of child at i
                    staging.push(current);
                }
                staging.sort();
                level.push(...staging);
            } else {*/
            let start = 0;
            let flen = 0;
            let flagNode = this.getFlagNodeIfExists(node.children);
            if (flagNode) {
                start = 1;
                // fixme: abort when a flag node is marked as such but has no value stored?
                if (typeof (flagNode.letter) === "undefined" || typeof (flagNode) === "undefined") {
                    console.log("flagnode letter undef ", flagNode, " node ", node);
                }
                const encValue = (config.base32) ?
                    base32.encode(flagNode.letter) :
                    new BitString(flagNode.letter).encode(8);
                flen = encValue.length;
                for (let i = 0; i < encValue.length; i++) {
                    const l = encValue[i];
                    const aux = config.base32 ? new TrieNode2(l) : new TrieNode2([l]);
                    aux.flag = true;
                    level.push(aux);
                }
                nbb += 1
            }

            for (let i = start; i < childrenLength; i++) {
                const current = node.children[i];
                if (config.inspect) inspect[current.letter.length] = (inspect[current.letter.length + flen] | 0) + 1;
                for (let j = 0; j < current.letter.length - 1; j++) {
                    const l = current.letter[j]
                    const aux = config.base32 ? new TrieNode2(l) : new TrieNode2([l]);
                    aux.compressed = true
                    level.push(aux)
                }
                // current node represents the last letter
                level.push(current); node
            }
        }
        if (config.inspect) console.log(inspect);
        return { level: level, div: ord };
    },

    indexBits: function (index) {
        if (index > 0 && !this.indexBitsArray[index]) {
            this.indexBitsArray[index] = new String().padStart(index, "1") + "0";
        }
        return this.indexBitsArray[index];
    },

    /**
     * Encode the trie and all of its nodes. Returns a string representing the
     * encoded data.
     */
    encode: function () {
        // base32 => 5 bits per char, +2 bits node metadata
        // utf8   => 8 bits per char, +2 bits node metadata
        // final-node:      0x20 => 001 0 0000 | 0x100 => 0001 0000 0000
        // compressed-node: 0x40 => 010 0 0000 | 0x200 => 0010 0000 0000
        // flag/value-node: 0x60 => 011 0 0000 | 0x300 => 0011 0000 0000
        const finalMask = (config.base32) ? 0x20 : 0x100;
        const compressedMask = (config.base32) ? 0x40 : 0x200;
        const flagMask = (config.base32) ? 0x60 : 0x300;
        this.invoke += 1;
        // Write the unary encoding of the tree in level order.
        let bits = new BitWriter();
        let chars = []
        let vals = []
        let indices = []

        bits.write(0x02, 2);

        this.stats = { children: 0, single: new Array(config.base32 ? 32 : 256).fill(0) }
        let start = new Date().getTime();
        const levelorder = this.levelorder();
        const level = levelorder.level;
        const div = levelorder.div;
        let nbb = 0;

        console.log("levlen", level.length, "nodecount", this.nodeCount, " masks ", compressedMask, flagMask, finalMask);

        const l10 = level.length / 5 | 0;
        for (let i = 0; i < level.length; i++) {
            const node = level[i];
            const childrenLength = (node.children) ? node.children.length : 0;
            const size = (config.compress && !config.unroll) ? childrenSize(node) : childrenLength;
            nbb += size

            if (i % l10 == 0) console.log("at encode[i]: " + i)
            this.stats.single[childrenLength] += 1;

            for (let j = 0; j < size; j++) {
                bits.write(1, 1);
            }
            bits.write(0, 1);
            if (config.compress && !config.unroll) {
                const letter = node.letter[node.letter.length - 1];
                let value = (config.base32) ? base32.lookup[letter] : letter;
                if (node.final) {
                    value |= finalMask;
                    this.stats.children += 1;
                    if (!config.valueNode) {
                        vals.push(node.flag)
                        indices.push(i)
                    }
                }
                if (node.compressed) {
                    value |= compressedMask;
                }
                if (config.valueNode && node.flag === true) {
                    value |= flagMask;
                }
                chars.push(value);
                if (config.inspect) this.inspect[i + "_" + node.letter] = {v: value, l: node.letter, f: node.final, c: node.compressed}
            } else {
                const letter = node.letter[0];
                let value = (config.base32) ? base32.lookup[letter] : letter;
                /*if (typeof(value) == "undefined") {
                    value = 0;
                    console.log("val undefined: " + node.letter )
                }*/
                if (node.final) {
                    value |= finalMask;
                    this.stats.children += 1;
                    if (!config.valueNode) {
                        vals.push(node.flag)
                        indices.push(i)
                    }
                }
                chars.push(value);
            }
        }
        if (config.inspect) console.log(indices, vals)

        let elapsed2 = new Date().getTime() - start;

        // Write the data for each node, using 6 bits for node. 1 bit stores
        // the "final" indicator. The other 5 bits store one of the 26 letters
        // of the alphabet.
        start = new Date().getTime();
        const extraBit = (config.compress && !config.unroll) ? 1 : 0;
        const bitslen = extraBit + ((config.base32) ? 6 : 9);
        console.log('charslen: ' + chars.length + ", bitslen: " + bitslen, " letterstart", bits.top);
        let k = 0;
        for (c of chars) {
            if (k % (chars.length / 10 | 0) == 0) console.log("charslen: " + k);
            bits.write(c, bitslen)
            k += 1;
        }

        let elapsed = new Date().getTime() - start;
        console.log(this.invoke + " csize: " + nbb + " elapsed write.keys: " + elapsed2 + " elapsed write.values: " + elapsed +
            " stats: f: " + this.stats.children + ", c:" + this.stats.single);

        if (config.valueNode === false) {
            const bitslenindex = Math.ceil(Math.log2(t.getNodeCount()))
            const bitslenvalue = 16;
            let insp = []
            for (let i = 0; i < vals.length; i++) {
                const index = indices[i]
                const value = vals[i]

                bits.write(index, bitslenindex);
                let ininsp = []
                for (v of value) {
                    if (config.inspect) ininsp.push(DEC16(v));
                    bits.write(DEC16(v), bitslenvalue);
                }
                if (config.inspect) insp.push(ininsp);
            }
            if (config.inspect) console.log(insp);
        }

        if (config.storeMeta) {
            console.log("metadata-start ", bits.top)
            bits.write(this.nodeCount, MFIELDBITS);
        }

        return bits.getData();
    }
};

//fixme: move to trie's prototype
function childrenSize(tn) {
    let size = 0;

    if (!tn.children) return size;

    if (config.valueNode === true) {
        for (c of tn.children) {
            let len = c.letter.length;
            if (c.flag) {
                // calculate the actual length of flag-nodes: base32 (5bits / char)
                // or bit-string (16bits / char)
                len = config.base32 ? base32.encode(c.letter).length : len * 2;
            }
            size += len;
        }
        return size;
    }

    for (c of tn.children) {
        size += c.letter.length;
    }
    return size;
}

/**
 * This class is used for traversing the succinctly encoded trie.
 */
function FrozenTrieNode(trie, index) {
    this.trie = trie;
    this.index = index;

    // retrieve the 7-bit/6-bit letter.
    let finCached, whCached, comCached, fcCached, chCached, valCached, flagCached;
    this.final = () => {
        if (typeof (finCached) === "undefined") {
            finCached = this.trie.data.get(this.trie.letterStart + (index * this.trie.bitslen) + this.trie.extraBit, 1) === 1;
        }
        return finCached;
    }
    this.where = () => {
        if (typeof (whCached) === "undefined") {
            whCached = this.trie.data.get(this.trie.letterStart + (index * this.trie.bitslen) + 1 + this.trie.extraBit, this.trie.bitslen - 1 - this.trie.extraBit);
        }
        return whCached;
    }
    this.compressed = () => {
        if (typeof (comCached) === "undefined") {
            comCached = ((config.compress && !config.unroll) ? this.trie.data.get(this.trie.letterStart + (index * this.trie.bitslen), 1) : 0) === 1;
        }
        return comCached;
    }
    this.flag = () => {
        if (typeof (flagCached) === "undefined") {
            flagCached = (config.valueNode) ? this.compressed() && this.final() : false;
        }
        return flagCached;
    }

    this.letter = () => (config.base32) ? base32.index[this.where()] : this.where();

    this.firstChild = () => {
        if (!fcCached) {
            fcCached = this.trie.directory.select(0, index + 1) - index;
        }
        return fcCached;
    }

    if (config.debug) {
        console.log(index + " :i, fc: " + this.firstChild() + " tl: " + this.letter() +
                " c: " + this.compressed() + " f: " + this.final() + " wh: " + this.where() +
                " flag: " + this.flag());
    }

    // Since the nodes are in level order, this nodes children must go up
    // until the next node's children start.
    this.childOfNextNode = () => {
        if (!chCached) {
            chCached = this.trie.directory.select(0, index + 2) - index - 1;
        }
        return chCached;
    }

    this.childCount = () => this.childOfNextNode() - this.firstChild();

    this.value = (config.valueNode) ?
        () => {

            if (typeof (valCached) === "undefined") {
                let value = [];
                let i = 0;
                let j = 0;
                if (config.debug) console.log("thisnode: index/vc/ccount ", this.index, this.letter(), this.childCount())
                while (i < this.childCount()) {
                    let valueChain = this.getChild(i);
                    if (config.debug) console.log("vc no-flag end vlet/vflag/vindex/val ", i, valueChain.letter(), valueChain.flag(), valueChain.index, value)
                    if (!valueChain.flag()) {
                        break;
                    }
                    if (i % 2 === 0) {
                        value.push(valueChain.letter() << 8);
                    } else {
                        value[j] = (value[j] | valueChain.letter());
                        j += 1;
                    }
                    i += 1;
                }
                valCached = (config.base32) ? base32.decode(value.join("")) : value;
            }

            return valCached;
        } :
        () => {
            if (typeof (valCached) === "undefined") {
                const vdir = this.trie.directory.valueDir;
                const data = this.trie.data;

                const start = this.trie.valuesStart;
                const end = data.length;

                const vdirlen = this.trie.valuesDirBitsLength;
                const vindexlen = this.trie.valuesIndexLength;
                const vlen = 16;

                const p = (this.index / V1 | 0) * vdirlen;
                const bottomIndex = start + vdir.get(p, vdirlen);

                for (let i = bottomIndex; i < end;) {
                    const currentIndex = data.get(i, vindexlen);
                    const vheader = data.get(i + vindexlen, vlen);
                    const vcount = countSetBits(vheader);
                    if (currentIndex === this.index) {
                        const vflag = [];
                        vflag.push(vheader);
                        for (let k = 1; k <= vcount; k++) {
                            const f = data.get((i + vindexlen) + (k * vlen), vlen);
                            vflag.push(f)
                        }
                        valCached = vflag;
                        break;
                    } else if (currentIndex > this.index) {
                        if (config.debug) {
                            console.log("error currentindex > this.index: vh: vcount ", currentIndex, this.index, vheader, vcount,
                                    "s:e:vdl:vil", start, end, vdirlen, vindexlen, "p:bottomIndex", p, bottomIndex)
                        }
                        valCached = -1;
                        break;
                    } else if (currentIndex < this.index) {
                        const vhop = (vcount + 1) * vlen;
                        i += vhop + vindexlen;
                    }
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

        nodeCount = nodeCountFromEncodedDataIfExists(this.data, nodeCount);

        this.extraBit = (config.compress && !config.unroll) ? 1 : 0;
        this.bitslen = ((config.base32) ? 6 : 9) + this.extraBit;

        // The position of the first bit of the data in 0th node. In non-root
        // nodes, this would contain bitslen letters.
        this.letterStart = nodeCount * 2 + 1;

        // The bit-position in this.data where the values of the final nodes start
        // fixme: should there be a +1?
        this.valuesStart = this.letterStart + (nodeCount * this.bitslen); // + 1;

        this.valuesIndexLength = Math.ceil(Math.log2(nodeCount));

        this.valuesDirBitsLength = Math.ceil(Math.log2(this.data.length - this.valuesStart));
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
        let periodEncVal = TxtEnc.encode(".")
        let returnValue = false
        for (let i = 0; i < word.length; i++) {
            let isFlag = -1;
            let that;
            if (periodEncVal[0] == word[i]) {
                if (node.final()) {
                    if (returnValue == false) { returnValue = new Map() }
                    returnValue.set(TxtDec.decode(word.slice(0, i).reverse()), node.value())
                }
            }
            do {
                that = node.getChild(isFlag + 1);
                if (!that.flag()) break;
                isFlag += 1;
            } while (isFlag + 1 < node.getChildCount());

            const minChild = isFlag;
            if (debug) console.log("            count: " + node.getChildCount() + " i: " + i + " w: " + word[i] + " nl: " + node.letter() + " flag: " + isFlag)

            if ((node.getChildCount() - 1) <= minChild) {
                if (debug) console.log("  no more children left, remaining word: " + word.slice(i));
                // fixme: fix these return false to match the actual return value?
                return returnValue;
            }
            if (config.useBinarySearch === false) {
                let j = isFlag;
                for (; j < node.getChildCount(); j++) {
                    child = node.getChild(j);
                    if (debug) console.log("it: " + j + " tl: " + child.letter() + " wl: " + word[i])
                    if (child.letter() == word[i]) {
                        if (debug) console.log("it: " + j + " break ")
                        break;
                    }
                }

                if (j === node.getChildCount()) {
                    if (debug) console.log("j: " + j + " c: " + node.getChildCount())
                    return returnValue;
                }
            }
            else if (config.compress === true && !config.unroll) {
                let high = node.getChildCount();
                let low = isFlag;

                while (high - low > 1) {
                    let probe = (high + low) / 2 | 0;
                    child = node.getChild(probe);
                    const prevchild = (probe > isFlag) ? node.getChild(probe - 1) : undefined;
                    if (debug) console.log("        current: " + child.letter() + " l: " + low + " h: " + high + " w: " + word[i])

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
                            const temp = node.getChild(probe - start)
                            if (!temp.compressed()) break;
                            if (temp.flag()) break;
                            startchild.push(temp);
                            start += 1
                        } while (true);

                        if (debug) console.log("  check: letter : "+startchild[start - 1].letter()+" word : "+word[i]+" start: "+start)
                        if (startchild[start - 1].letter() > word[i]) {
                            if (debug) console.log("        shrinkh start: " + startchild[start - 1].letter() + " s: " + start + " w: " + word[i])

                            high = probe - start + 1;
                            if (high - low <= 1) {
                                if (debug) console.log("...h-low: " + (high - low) + " c: " + node.getChildCount(), high, low, child.letter(), word[i], probe)
                                return returnValue;
                            }
                            continue;
                        }

                        // if the child itself the last-node in the seq
                        // nothing to do, there's no endchild to track
                        if (child.compressed()) {
                            do {
                                end += 1
                                const temp = node.getChild(probe + end);
                                endchild.push(temp);
                                if (!temp.compressed()) break;
                                // cannot encounter a flag whilst probing higher indices
                                // since flag is always at index 0.
                            } while (true);
                        }

                        if (startchild[start - 1].letter() < word[i]) {
                            if (debug) console.log("        shrinkl start: " + startchild[start - 1].letter() + " s: " + start + " w: " + word[i])

                            low = probe + end;

                            if (high - low <= 1) {
                                if (debug) console.log("...h-low: " + (high - low) + " c: " + node.getChildCount(), high, low, child.letter(), word[i], probe)
                                return returnValue;
                            }
                            continue;
                        }

                        const nodes = startchild.reverse().concat(endchild);
                        let comp = nodes.map(n => n.letter());
                        const w = word.slice(i, i + comp.length);

                        if (debug) console.log("it: " + probe + " tl: " + comp + " wl: " + w + " c: " + child.letter());

                        if (w.length < comp.length) return returnValue;
                        for (let i = 0; i < comp.length; i++) {
                            if (w[i] !== comp[i]) return returnValue;
                        }

                        if (debug) console.log("it: " + probe + " break ")

                        // final letter in compressed node is representative of all letters
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
                        if (debug) console.log("h-low: " + (high - low) + " c: " + node.getChildCount(), high, low, child.letter(), word[i], probe)
                        return returnValue;
                    }
                }
            } else {
                let high = node.getChildCount();
                let low = -1;

                if (debug) console.log("             c: " + node.getChildCount())
                while (high - low > 1) {
                    let probe = (high + low) / 2 | 0;
                    child = node.getChild(probe);

                    if (debug) console.log("it: " + probe + " tl: " + child.letter() + " wl: " + word[i])
                    if (child.letter() === word[i]) {
                        if (debug) console.log("it: " + probe + " break ")
                        break;
                    } else if (word[i] > child.letter()) {
                        low = probe;
                    } else {
                        high = probe;
                    }
                }

                if (high - low <= 1) {
                    if (debug) console.log("h-low: " + (high - low) + " c: " + node.getChildCount())
                    return returnValue;
                }
            }

            if (debug) console.log("        next: " + child.letter())

            node = child;
        }

        // using node.index, find value in rd.data after letterStart + (bitslen * nodeCount) + 1
        // level order indexing, fixme: see above re returning "false" vs [false] vs [[0], false]
        //return (node.final()) ? [node.value(), node.final()] : node.final();
        if (node.final()) {
            if (returnValue == false) { returnValue = new Map() }
            returnValue.set(TxtDec.decode(word.reverse()), node.value())
        }
        return returnValue
    }
};

let base32;

/**
 * [hi-base32]{@link https://github.com/emn178/hi-base32}
 *
 * @version 0.5.0
 * @author Chen, Yi-Cyuan [emn178@gmail.com]
 * @copyright Chen, Yi-Cyuan 2015-2018
 * @license MIT
 */
/*jslint bitwise: true */
(function () {

    var BASE32_ENCODE_CHAR = '0123456789abcdefghjkmnpqrtuvwxyz'.split('');
    var BASE32_DECODE_CHAR = {
        '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
        '9': 9, 'a': 10, 'b': 11, 'c': 12, 'd': 13, 'e': 14, 'f': 15, 'g': 16,
        'h': 17, 'j': 18, 'k': 19, 'm': 20, 'n': 21, 'p': 22, 'q': 23, 'r': 24,
        't': 25, 'u': 26, 'v': 27, 'w': 28, 'x': 29, 'y': 30, 'z': 31
    };
    const pad = false

    var lookup = BASE32_DECODE_CHAR

    var index = BASE32_ENCODE_CHAR

    var blocks = [0, 0, 0, 0, 0, 0, 0, 0];

    var throwInvalidUtf8 = function (position, partial) {
        if (partial.length > 10) {
            partial = '...' + partial.substr(-10);
        }
        var err = new Error('Decoded data is not valid UTF-8.'
            + ' Maybe try base32.decode.asBytes()?'
            + ' Partial data after reading ' + position + ' bytes: ' + partial + ' <-');
        err.position = position;
        throw err;
    };

    var toUtf8String = function (bytes) {
        var str = '', length = bytes.length, i = 0, followingChars = 0, b, c;
        while (i < length) {
            b = bytes[i++];
            if (b <= 0x7F) {
                str += String.fromCharCode(b);
                continue;
            } else if (b > 0xBF && b <= 0xDF) {
                c = b & 0x1F;
                followingChars = 1;
            } else if (b <= 0xEF) {
                c = b & 0x0F;
                followingChars = 2;
            } else if (b <= 0xF7) {
                c = b & 0x07;
                followingChars = 3;
            } else {
                throwInvalidUtf8(i, str);
            }

            for (var j = 0; j < followingChars; ++j) {
                b = bytes[i++];
                if (b < 0x80 || b > 0xBF) {
                    throwInvalidUtf8(i, str);
                }
                c <<= 6;
                c += b & 0x3F;
            }
            if (c >= 0xD800 && c <= 0xDFFF) {
                throwInvalidUtf8(i, str);
            }
            if (c > 0x10FFFF) {
                throwInvalidUtf8(i, str);
            }

            if (c <= 0xFFFF) {
                str += String.fromCharCode(c);
            } else {
                c -= 0x10000;
                str += String.fromCharCode((c >> 10) + 0xD800);
                str += String.fromCharCode((c & 0x3FF) + 0xDC00);
            }
        }
        return str;
    };

    var decodeAsBytes = function (base32Str) {
        if (!/^[a-z0-9=]+$/.test(base32Str)) {
            throw new Error('Invalid base32 characters');
        }
        base32Str = base32Str.replace(/=/g, '');
        var v1, v2, v3, v4, v5, v6, v7, v8, bytes = [], index = 0, length = base32Str.length;

        // 4 char to 3 bytes
        for (var i = 0, count = length >> 3 << 3; i < count;) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v5 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v6 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v7 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v8 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            bytes[index++] = (v1 << 3 | v2 >>> 2) & 255;
            bytes[index++] = (v2 << 6 | v3 << 1 | v4 >>> 4) & 255;
            bytes[index++] = (v4 << 4 | v5 >>> 1) & 255;
            bytes[index++] = (v5 << 7 | v6 << 2 | v7 >>> 3) & 255;
            bytes[index++] = (v7 << 5 | v8) & 255;
        }

        // remain bytes
        var remain = length - count;
        if (remain === 2) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            bytes[index++] = (v1 << 3 | v2 >>> 2) & 255;
        } else if (remain === 4) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            bytes[index++] = (v1 << 3 | v2 >>> 2) & 255;
            bytes[index++] = (v2 << 6 | v3 << 1 | v4 >>> 4) & 255;
        } else if (remain === 5) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v5 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            bytes[index++] = (v1 << 3 | v2 >>> 2) & 255;
            bytes[index++] = (v2 << 6 | v3 << 1 | v4 >>> 4) & 255;
            bytes[index++] = (v4 << 4 | v5 >>> 1) & 255;
        } else if (remain === 7) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v5 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v6 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v7 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            bytes[index++] = (v1 << 3 | v2 >>> 2) & 255;
            bytes[index++] = (v2 << 6 | v3 << 1 | v4 >>> 4) & 255;
            bytes[index++] = (v4 << 4 | v5 >>> 1) & 255;
            bytes[index++] = (v5 << 7 | v6 << 2 | v7 >>> 3) & 255;
        }
        return bytes;
    };

    var encodeAscii = function (str) {
        var v1, v2, v3, v4, v5, base32Str = '', length = str.length;
        for (var i = 0, count = parseInt(length / 5) * 5; i < count;) {
            v1 = str.charCodeAt(i++);
            v2 = str.charCodeAt(i++);
            v3 = str.charCodeAt(i++);
            v4 = str.charCodeAt(i++);
            v5 = str.charCodeAt(i++);
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                BASE32_ENCODE_CHAR[(v3 << 1 | v4 >>> 7) & 31] +
                BASE32_ENCODE_CHAR[(v4 >>> 2) & 31] +
                BASE32_ENCODE_CHAR[(v4 << 3 | v5 >>> 5) & 31] +
                BASE32_ENCODE_CHAR[v5 & 31];
        }

        // remain char
        var remain = length - count;
        if (remain === 1) {
            v1 = str.charCodeAt(i);
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2) & 31];
            if (pad) base32Str += '======';
        } else if (remain === 2) {
            v1 = str.charCodeAt(i++);
            v2 = str.charCodeAt(i);
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4) & 31];
            if (pad) base32Str += '====';
        } else if (remain === 3) {
            v1 = str.charCodeAt(i++);
            v2 = str.charCodeAt(i++);
            v3 = str.charCodeAt(i);
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                BASE32_ENCODE_CHAR[(v3 << 1) & 31];
            if (pad) base32Str += '===';
        } else if (remain === 4) {
            v1 = str.charCodeAt(i++);
            v2 = str.charCodeAt(i++);
            v3 = str.charCodeAt(i++);
            v4 = str.charCodeAt(i);
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                BASE32_ENCODE_CHAR[(v3 << 1 | v4 >>> 7) & 31] +
                BASE32_ENCODE_CHAR[(v4 >>> 2) & 31] +
                BASE32_ENCODE_CHAR[(v4 << 3) & 31];
            if (pad) base32Str += '=';
        }
        return base32Str;
    };

    var encodeUtf8 = function (str) {
        var v1, v2, v3, v4, v5, code, end = false, base32Str = '',
            index = 0, i, start = 0, bytes = 0, length = str.length;
        do {
            blocks[0] = blocks[5];
            blocks[1] = blocks[6];
            blocks[2] = blocks[7];
            for (i = start; index < length && i < 5; ++index) {
                code = str.charCodeAt(index);
                if (code < 0x80) {
                    blocks[i++] = code;
                } else if (code < 0x800) {
                    blocks[i++] = 0xc0 | (code >> 6);
                    blocks[i++] = 0x80 | (code & 0x3f);
                } else if (code < 0xd800 || code >= 0xe000) {
                    blocks[i++] = 0xe0 | (code >> 12);
                    blocks[i++] = 0x80 | ((code >> 6) & 0x3f);
                    blocks[i++] = 0x80 | (code & 0x3f);
                } else {
                    code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(++index) & 0x3ff));
                    blocks[i++] = 0xf0 | (code >> 18);
                    blocks[i++] = 0x80 | ((code >> 12) & 0x3f);
                    blocks[i++] = 0x80 | ((code >> 6) & 0x3f);
                    blocks[i++] = 0x80 | (code & 0x3f);
                }
            }
            bytes += i - start;
            start = i - 5;
            if (index === length) {
                ++index;
            }
            if (index > length && i < 6) {
                end = true;
            }
            v1 = blocks[0];
            if (i > 4) {
                v2 = blocks[1];
                v3 = blocks[2];
                v4 = blocks[3];
                v5 = blocks[4];
                base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                    BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                    BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                    BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                    BASE32_ENCODE_CHAR[(v3 << 1 | v4 >>> 7) & 31] +
                    BASE32_ENCODE_CHAR[(v4 >>> 2) & 31] +
                    BASE32_ENCODE_CHAR[(v4 << 3 | v5 >>> 5) & 31] +
                    BASE32_ENCODE_CHAR[v5 & 31];
            } else if (i === 1) {
                base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                    BASE32_ENCODE_CHAR[(v1 << 2) & 31];
                if (pad) base32Str += '======';
            } else if (i === 2) {
                v2 = blocks[1];
                base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                    BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                    BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                    BASE32_ENCODE_CHAR[(v2 << 4) & 31];
                if (pad) base32Str += '====';
            } else if (i === 3) {
                v2 = blocks[1];
                v3 = blocks[2];
                base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                    BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                    BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                    BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                    BASE32_ENCODE_CHAR[(v3 << 1) & 31];
                if (pad) base32Str += '===';
            } else {
                v2 = blocks[1];
                v3 = blocks[2];
                v4 = blocks[3];
                base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                    BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                    BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                    BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                    BASE32_ENCODE_CHAR[(v3 << 1 | v4 >>> 7) & 31] +
                    BASE32_ENCODE_CHAR[(v4 >>> 2) & 31] +
                    BASE32_ENCODE_CHAR[(v4 << 3) & 31];
                if (pad) base32Str += '=';
            }
        } while (!end);
        return base32Str;
    };

    var encodeBytes = function (bytes) {
        var v1, v2, v3, v4, v5, base32Str = '', length = bytes.length;
        for (var i = 0, count = parseInt(length / 5) * 5; i < count;) {
            v1 = bytes[i++];
            v2 = bytes[i++];
            v3 = bytes[i++];
            v4 = bytes[i++];
            v5 = bytes[i++];
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                BASE32_ENCODE_CHAR[(v3 << 1 | v4 >>> 7) & 31] +
                BASE32_ENCODE_CHAR[(v4 >>> 2) & 31] +
                BASE32_ENCODE_CHAR[(v4 << 3 | v5 >>> 5) & 31] +
                BASE32_ENCODE_CHAR[v5 & 31];
        }

        // remain char
        var remain = length - count;
        if (remain === 1) {
            v1 = bytes[i];
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2) & 31];
            if (pad) base32Str += '======';
        } else if (remain === 2) {
            v1 = bytes[i++];
            v2 = bytes[i];
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4) & 31];
            if (pad) base32Str += '====';
        } else if (remain === 3) {
            v1 = bytes[i++];
            v2 = bytes[i++];
            v3 = bytes[i];
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                BASE32_ENCODE_CHAR[(v3 << 1) & 31];
            if (pad) base32Str += '===';
        } else if (remain === 4) {
            v1 = bytes[i++];
            v2 = bytes[i++];
            v3 = bytes[i++];
            v4 = bytes[i];
            base32Str += BASE32_ENCODE_CHAR[v1 >>> 3] +
                BASE32_ENCODE_CHAR[(v1 << 2 | v2 >>> 6) & 31] +
                BASE32_ENCODE_CHAR[(v2 >>> 1) & 31] +
                BASE32_ENCODE_CHAR[(v2 << 4 | v3 >>> 4) & 31] +
                BASE32_ENCODE_CHAR[(v3 << 1 | v4 >>> 7) & 31] +
                BASE32_ENCODE_CHAR[(v4 >>> 2) & 31] +
                BASE32_ENCODE_CHAR[(v4 << 3) & 31];
            if (pad) base32Str += '=';
        }
        return base32Str;
    };

    var encode = function (input, asciiOnly) {
        var notString = typeof (input) !== 'string';
        if (notString && input.constructor === ArrayBuffer) {
            input = new Uint8Array(input);
        }
        if (notString) {
            return encodeBytes(input);
        } else if (asciiOnly) {
            return encodeAscii(input);
        } else {
            return encodeUtf8(input);
        }
    };

    var decode = function (base32Str, asciiOnly) {
        if (!asciiOnly) {
            return toUtf8String(decodeAsBytes(base32Str));
        }
        if (!/^[a-z0-9=]+$/.test(base32Str)) {
            throw new Error('Invalid base32 characters');
        }
        var v1, v2, v3, v4, v5, v6, v7, v8, str = '', length = base32Str.indexOf('=');
        if (length === -1) {
            length = base32Str.length;
        }

        // 8 char to 5 bytes
        for (var i = 0, count = length >> 3 << 3; i < count;) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v5 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v6 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v7 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v8 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            str += String.fromCharCode((v1 << 3 | v2 >>> 2) & 255) +
                String.fromCharCode((v2 << 6 | v3 << 1 | v4 >>> 4) & 255) +
                String.fromCharCode((v4 << 4 | v5 >>> 1) & 255) +
                String.fromCharCode((v5 << 7 | v6 << 2 | v7 >>> 3) & 255) +
                String.fromCharCode((v7 << 5 | v8) & 255);
        }

        // remain bytes
        var remain = length - count;
        if (remain === 2) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            str += String.fromCharCode((v1 << 3 | v2 >>> 2) & 255);
        } else if (remain === 4) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            str += String.fromCharCode((v1 << 3 | v2 >>> 2) & 255) +
                String.fromCharCode((v2 << 6 | v3 << 1 | v4 >>> 4) & 255);
        } else if (remain === 5) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v5 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            str += String.fromCharCode((v1 << 3 | v2 >>> 2) & 255) +
                String.fromCharCode((v2 << 6 | v3 << 1 | v4 >>> 4) & 255) +
                String.fromCharCode((v4 << 4 | v5 >>> 1) & 255);
        } else if (remain === 7) {
            v1 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v2 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v3 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v4 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v5 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v6 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            v7 = BASE32_DECODE_CHAR[base32Str.charAt(i++)];
            str += String.fromCharCode((v1 << 3 | v2 >>> 2) & 255) +
                String.fromCharCode((v2 << 6 | v3 << 1 | v4 >>> 4) & 255) +
                String.fromCharCode((v4 << 4 | v5 >>> 1) & 255) +
                String.fromCharCode((v5 << 7 | v6 << 2 | v7 >>> 3) & 255);
        }
        return str;
    };

    base32 = {
        encode: encode,
        decode: decode,
        lookup: lookup,
        index: index
    };
})();

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

var sbb32r, anb32r, adb32r, madb32r, yhb32r, vnb32r, allb32r, dblb32r, enb32r;
var t, td, rd, ft;
var tag, fl;

async function build(blocklist, filesystem, savelocation, tag_dict, basicconfig) {

    let nodeCount = 0;
    // DELIM shouldn't be a valid base32 char
    // in key:value pair, key cannot be anything that coerces to boolean false
    tag = {}
    fl = []
    for (t in tag_dict) {
        if (!tag_dict.hasOwnProperty(t)) continue;
        fl[tag_dict[t].value] = t
        if (config.base32 === true) continue;
        // reverse the value since it is prepended to
        // the front of key when not encoded with base32
        const v = DELIM + tag_dict[t].uname;
        tag[t] = v.split("").reverse().join("")
    }
    initialize();

    t = new Trie()
    t.setupFlags(fl)
    config.base32 = false


    try {
        allb32r = []
        var tmplist = []
        let filecount = 0
        let linecount = 0
        let totallinecount = 0
        let uniqueentry = new Set()
        for (filepath of blocklist) {
            linecount = 0
            let namesplit = filepath.split("/")
            let smallname = namesplit[namesplit.length - 1].split(".")[0]
            var fileData = filesystem.readFileSync(filepath, 'utf8');
            if (fileData.length > 1) {
                console.log("adding: " + filepath, smallname + " <-file | tag-> "+tag[smallname])
                var filelist = []
                for (let line of fileData.split("\n")) {
                    linecount++
                    line = line.trim()
                    uniqueentry.add(line)
                    allb32r.push(TxtEnc.encode(tag[smallname] + line).reverse())
                }
                totallinecount = totallinecount + linecount
                tag_dict[smallname].entries = linecount
                if ( tag_dict[smallname].entries > 1 ){
                    tag_dict[smallname].show = 1
                }
                filecount = filecount + 1
            }
            else {
                console.log("empty file", filepath)
            }
        }
        console.log("Lines: " + totallinecount)
        console.log("unique entries: " + uniqueentry.size)
        console.log("Total files: " + filecount)
    } catch (e) {
        console.error(e)
        throw new Error("error building trie")
    }

    if (config.base32) {
        allb32r.sort();
    } else {
        allb32r.sort(lex);
    }

    console.log("Building Trie")
    const start = new Date().getTime();
    allb32r.forEach(s => t.insert(s));
    td = t.encode();
    nodeCount = t.getNodeCount();
    console.log("Node count: " + nodeCount)
    rd = RankDirectory.Create(td, nodeCount, L1, L2);

    ft = new FrozenTrie(td, rd, nodeCount)
    const end = new Date().getTime();

    console.log("time (ms) spent creating blocklist: ", end - start);

    console.log("saving td and rd")

    if(!filesystem.existsSync(savelocation)){
        filesystem.mkdirSync(savelocation)
    }
    let aw1 = filesystem.writeFile(savelocation + "td.txt", td, function (err) {
        if (err) {
            console.log(err);
            throw err
        }
        console.log('td write to file successful');
    });
    let aw2 = filesystem.writeFile(savelocation + "rd.txt", rd.directory.bytes, function (err) {
        if (err) {
            console.log(err);
            throw err
        }
        console.log('rd write to file successful');
    });

    basicconfig.nodecount = nodeCount

    let aw3 = filesystem.writeFile(savelocation + "basicconfig.json", JSON.stringify(basicconfig), function (err) {
        if (err) {
            console.log(err);
            throw err
        }
        console.log('basic json write to file successful');
    });


    let aw4 = filesystem.writeFile(savelocation + "filetag.json", JSON.stringify(tag_dict), function (err) {
        if (err) {
            console.log(err);
            throw err
        }
        console.log('filetag write to file successful');
    });

    await Promise.all([aw1, aw2, aw3, aw4]);

    console.log("Test Blocklist Filter")

    let dnlist = ["sg-ssl.effectivemeasure.net", "staging.connatix.com", "ads.redlightcenter.com", "oascentral.chicagobusiness.com", "simpsonitos.com", "putlocker.fyi", "celzero.com"]
    for (let domainname of dnlist) {
        let ts = TxtEnc.encode(domainname).reverse()
        let serresult = ft.lookup(ts)
        console.log("query: " + domainname, "result: "+ serresult)
        if (serresult) {
            let converted = ""
            for (let [key, value] of serresult) {
                converted = t.flagsToTag(value)
                console.log(converted)
            }
        } else {
            console.warn("query not found in trie")
        }
    }
}

module.exports.build = build;

