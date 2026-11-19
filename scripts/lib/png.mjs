/**
 * png.mjs —— 极简 PNG 编码器（零依赖）
 *
 * 只做一件事：把 RGBA 像素缓冲编码成 PNG 文件字节。
 * 之所以自己写而不引第三方库：
 *   1) 本项目的美术资源是**代码生成**的，不需要手工导入图片；
 *   2) 不想给项目引入构建期依赖（sharp / pngjs 都要装包）；
 *   3) Node 自带 zlib，PNG 的 IDAT 正好是 zlib 流，实现只有几十行。
 *
 * 输出格式：8 位深、RGBA（color type 6）、无隔行、逐行 filter 0。
 */

import zlib from 'node:zlib';

/** PNG 文件签名 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32 查表（PNG 规范用的多项式 0xedb88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 拼一个 PNG chunk：长度 + 类型 + 数据 + CRC
 * @param {string} type 四字符类型，如 'IHDR'
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([lenBuf, body, crcBuf]);
}

/**
 * 把 RGBA 缓冲编码为 PNG
 * @param {number} width 宽（像素）
 * @param {number} height 高（像素）
 * @param {Uint8Array} rgba 长度必须是 width*height*4
 * @returns {Buffer} PNG 文件字节
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`像素缓冲长度不匹配：期望 ${width * height * 4}，实际 ${rgba.length}`);
  }

  // IHDR：宽高 + 位深 + 颜色类型 + 压缩/过滤/隔行
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type = RGBA
  ihdr[10] = 0; // compression = deflate
  ihdr[11] = 0; // filter = adaptive
  ihdr[12] = 0; // interlace = none

  // 原始扫描线：每行前面加一个 filter 字节（全 0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
