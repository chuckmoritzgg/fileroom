/**
 * Minimal QR code generator (byte mode, error correction level M, versions 1-13 = up to 331 bytes).
 * Invite links carry the room key in the URL fragment, so the QR code must be drawn on the device:
 * asking the server for the image (/api/qr) would hand it the key.
 */
(() => {
    'use strict';
    // Per version (level M): [error correction codewords per block, blocks, data codewords per block,
    //                         blocks of the second group (one more data codeword each)]
    const BLOCKS = [null,
        [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0], [16, 4, 27, 0], [18, 4, 31, 0],
        [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1], [30, 1, 50, 4], [22, 6, 36, 2], [22, 8, 37, 1]];
    const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
        [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62]];
    const MAX_VERSION = BLOCKS.length - 1;
    const dataCodewords = (v) => BLOCKS[v][1] * BLOCKS[v][2] + BLOCKS[v][3] * (BLOCKS[v][2] + 1);

    // GF(256) arithmetic for Reed-Solomon (polynomial 0x11D)
    function gfMul(x, y) {
        let z = 0;
        for (let i = 7; i >= 0; i--) {
            z = (z << 1) ^ ((z >>> 7) * 0x11D);
            z ^= ((y >>> i) & 1) * x;
        }
        return z;
    }
    function rsDivisor(degree) {
        const result = new Uint8Array(degree);
        result[degree - 1] = 1;
        let root = 1;
        for (let i = 0; i < degree; i++) {
            for (let j = 0; j < degree; j++) {
                result[j] = gfMul(result[j], root);
                if (j + 1 < degree) result[j] ^= result[j + 1];
            }
            root = gfMul(root, 2);
        }
        return result;
    }
    function rsRemainder(data, divisor) {
        const result = new Uint8Array(divisor.length);
        for (const b of data) {
            const factor = b ^ result[0];
            result.copyWithin(0, 1);
            result[result.length - 1] = 0;
            for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
        }
        return result;
    }

    function codewords(bytes, version) {
        const capacity = dataCodewords(version);
        const bits = [];
        const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
        push(4, 4); // byte mode
        push(bytes.length, version < 10 ? 8 : 16);
        for (const b of bytes) push(b, 8);
        push(0, Math.min(4, capacity * 8 - bits.length));
        while (bits.length % 8) bits.push(0);
        const data = new Uint8Array(capacity);
        for (let i = 0; i < bits.length; i++) data[i >>> 3] |= bits[i] << (7 - (i & 7));
        for (let i = bits.length / 8, pad = 0xEC; i < capacity; i++, pad ^= 0xEC ^ 0x11) data[i] = pad;

        const [ecLength, blocks1, size1, blocks2] = BLOCKS[version];
        const divisor = rsDivisor(ecLength);
        const blocks = [];
        for (let i = 0, pos = 0; i < blocks1 + blocks2; i++) {
            const size = size1 + (i < blocks1 ? 0 : 1);
            const block = data.subarray(pos, pos + size);
            pos += size;
            blocks.push({ data: block, ec: rsRemainder(block, divisor) });
        }
        const out = [];
        for (let i = 0; i <= size1; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
        for (let i = 0; i < ecLength; i++) for (const b of blocks) out.push(b.ec[i]);
        return out;
    }

    function build(bytes, version) {
        const size = version * 4 + 17;
        const modules = Array.from({ length: size }, () => new Uint8Array(size));
        const reserved = Array.from({ length: size }, () => new Uint8Array(size));
        const set = (x, y, dark) => { modules[y][x] = dark ? 1 : 0; reserved[y][x] = 1; };

        for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
        const finder = (cx, cy) => {
            for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy, dist = Math.max(Math.abs(dx), Math.abs(dy));
                if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
            }
        };
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        const align = ALIGN[version];
        for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
        const drawFormat = (mask) => {
            const data = mask; // level M = 00
            let rem = data;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const bits = ((data << 10) | rem) ^ 0x5412;
            const bit = (i) => ((bits >>> i) & 1) === 1;
            for (let i = 0; i <= 5; i++) set(8, i, bit(i));
            set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
            for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
            for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
            for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
            set(8, size - 8, true);
        };
        drawFormat(0); // reserves the area; the real mask is written below
        if (version >= 7) {
            let rem = version;
            for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            const bits = (version << 12) | rem;
            for (let i = 0; i < 18; i++) {
                const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
                set(a, b, dark); set(b, a, dark);
            }
        }

        const data = codewords(bytes, version);
        let i = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
                const x = right - j;
                const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
                if (!reserved[y][x] && i < data.length * 8) {
                    modules[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
                    i++;
                }
            }
        }

        const MASKS = [
            (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
            (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
            (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
        const applyMask = (mask) => {
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] ^= 1;
            }
        };
        const penalty = () => {
            let result = 0, dark = 0;
            const line = (get) => {
                let run = 0, color = -1, history = 0;
                for (let k = 0; k < size; k++) {
                    const c = get(k);
                    if (c === color) { run++; if (run === 5) result += 3; else if (run > 5) result++; } else { color = c; run = 1; }
                    history = ((history << 1) | c) & 0x7FF;
                    if (k >= 10 && (history === 0x5D0 || history === 0x05D)) result += 40; // finder-like 1011101 + 4 light
                }
            };
            for (let y = 0; y < size; y++) line((x) => modules[y][x]);
            for (let x = 0; x < size; x++) line((y) => modules[y][x]);
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                const c = modules[y][x];
                dark += c;
                if (x + 1 < size && y + 1 < size && c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
            }
            return result + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
        };
        let best = 0, bestPenalty = Infinity;
        for (let mask = 0; mask < 8; mask++) {
            applyMask(mask); drawFormat(mask);
            const p = penalty();
            if (p < bestPenalty) { bestPenalty = p; best = mask; }
            applyMask(mask); // XOR again = undo
        }
        applyMask(best); drawFormat(best);
        return modules;
    }

    /** Returns the module matrix (array of rows, 1 = dark) or null if the text is too long. */
    function matrix(text) {
        const bytes = new TextEncoder().encode(text);
        for (let version = 1; version <= MAX_VERSION; version++) {
            if (4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(version) * 8) return build(bytes, version);
        }
        return null;
    }

    /** SVG markup (dark modules on white, 4 modules quiet zone) or null if the text is too long. */
    function svg(text) {
        const m = matrix(text);
        if (!m) return null;
        const size = m.length, quiet = 4;
        let path = '';
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (!m[y][x]) continue;
                let run = 1;
                while (x + run < size && m[y][x + run]) run++;
                path += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
                x += run - 1;
            }
        }
        const full = size + quiet * 2;
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
            `<rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
    }

    window.FileRoomQR = { matrix, svg };
})();
