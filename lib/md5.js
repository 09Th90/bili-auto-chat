/**
 * 纯 JS MD5 实现（RFC 1321）。
 * Web Crypto 不支持 MD5，WBI 签名需要它。
 */

function toUtf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function add32(x, y) {
  return (x + y) >>> 0;
}

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

/**
 * 计算字符串的 MD5 摘要（32 位小写十六进制）。
 * @param {string} input
 * @returns {string}
 */
export function md5(input) {
  const bytes = toUtf8Bytes(String(input));
  const len = bytes.length;
  const nBlocks = ((len + 8) >>> 6) + 1;
  const totalLen = nBlocks * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[len] = 0x80;

  // 长度（位，小端）写在最后一块的末尾 8 字节
  const bitLen = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, bitLen >>> 0, true);
  dv.setUint32(totalLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let off = 0; off < totalLen; off += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(off + j * 4, true);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = add32(F, add32(A, add32(K[i], M[g])));
      A = D;
      D = C;
      C = B;
      B = add32(B, rotl(F, S[i]));
    }

    a0 = add32(a0, A);
    b0 = add32(b0, B);
    c0 = add32(c0, C);
    d0 = add32(d0, D);
  }

  function hexLE(x) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return s;
  }

  return hexLE(a0) + hexLE(b0) + hexLE(c0) + hexLE(d0);
}
