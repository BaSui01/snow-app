/**
 * 轻量 MD5（RFC 1321）纯 TypeScript 实现。
 *
 * 存在动机：Gravatar 头像地址 = `md5(小写去空格后的邮箱)`，而渲染进程拿不到
 * Node 的 `crypto`，Web Crypto 的 SubtleCrypto 又不支持 MD5（只有 SHA 系列），
 * 因此内置一份以避免为单个哈希引入新依赖。
 *
 * 仅用于计算公开标识（邮箱 → Gravatar 头像 URL），不用于任何安全用途。
 */

/** 每轮的左移位数（RFC 1321 定义）。 */
const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

/** 正弦常量表：`floor(abs(sin(i + 1)) * 2^32)`。 */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

/** 32 位循环左移。 */
const rotateLeft = (value: number, shift: number): number =>
  (value << shift) | (value >>> (32 - shift));

/** 把字符串按 UTF-8 展开为字节数组。 */
const toUtf8Bytes = (input: string): number[] => {
  const bytes: number[] = [];
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
};

/** 计算字符串的 MD5，返回 32 位小写十六进制摘要。 */
export const md5Hex = (input: string): string => {
  const bytes = toUtf8Bytes(input);

  // 填充：追加 0x80，补 0 至长度 ≡ 56 (mod 64)，再写 64 位小端比特长度。
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  const lowBits = bitLength >>> 0;
  const highBits = Math.floor(bitLength / 4294967296) >>> 0;
  for (let i = 0; i < 4; i++) {
    bytes.push((lowBits >>> (8 * i)) & 0xff);
  }
  for (let i = 0; i < 4; i++) {
    bytes.push((highBits >>> (8 * i)) & 0xff);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const base = offset + i * 4;
      words[i] =
        bytes[base] |
        (bytes[base + 1] << 8) |
        (bytes[base + 2] << 16) |
        (bytes[base + 3] << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let mix: number;
      let index: number;
      if (i < 16) {
        mix = (b & c) | (~b & d);
        index = i;
      } else if (i < 32) {
        mix = (d & b) | (~d & c);
        index = (5 * i + 1) % 16;
      } else if (i < 48) {
        mix = b ^ c ^ d;
        index = (3 * i + 5) % 16;
      } else {
        mix = c ^ (b | ~d);
        index = (7 * i) % 16;
      }

      const next = (mix + a + K[i] + words[index]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(next, SHIFT[i])) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  let digest = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) {
      digest += ((word >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return digest;
};
