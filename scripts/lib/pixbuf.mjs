/**
 * pixbuf.mjs —— 极简像素画布
 *
 * 提供绘制像素画需要的最小工具集：画点、画矩形、画圆、画线、
 * 描边、最近邻放大。所有颜色用 '#rrggbb' 或 '#rrggbbaa' 字符串表示。
 *
 * 之所以用「代码画」而不是「贴字符网格」：
 *   - 兵种图标有大量重复结构（人 + 武器 + 盾 + 马），
 *     用参数化函数拼装比手写 24×24 的字符网格省事得多，也更容易改；
 *   - 描边（outline）是像素风的关键一步，手写网格很难保证每张图风格统一。
 */

/** 解析颜色字符串 → [r, g, b, a] */
function parseColor(color) {
  if (Array.isArray(color)) return color;
  let hex = String(color).replace('#', '').trim();
  if (hex.length === 3) {
    // #abc → #aabbcc
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length === 6) hex += 'ff';
  const n = parseInt(hex, 16);
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** 二维像素画布 */
export class PixBuf {
  /**
   * @param {number} w 宽
   * @param {number} h 高
   */
  constructor(w, h) {
    this.w = w;
    this.h = h;
    /** @type {Uint8Array} RGBA，长度 w*h*4 */
    this.data = new Uint8Array(w * h * 4);
  }

  /** 画一个像素（alpha 混合，source-over） */
  set(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const [r, g, b, a] = parseColor(color);
    if (a === 0) return;
    const i = (y * this.w + x) * 4;
    const da = this.data[i + 3] / 255;
    const sa = a / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) {
      this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
      return;
    }
    this.data[i] = Math.round((r * sa + this.data[i] * da * (1 - sa)) / oa);
    this.data[i + 1] = Math.round((g * sa + this.data[i + 1] * da * (1 - sa)) / oa);
    this.data[i + 2] = Math.round((b * sa + this.data[i + 2] * da * (1 - sa)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }

  /** 读一个像素，返回 [r,g,b,a]（越界返回全 0） */
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  /** 该点是否完全不透明 */
  isOpaque(x, y) {
    return this.get(x, y)[3] > 0;
  }

  /** 擦除一个像素（置为完全透明） */
  erase(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
  }

  /** 擦除一个矩形区域 */
  eraseRect(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.erase(xx, yy);
    }
  }

  /**
   * 把另一张画布叠到当前画布上（source-over）
   * @param {PixBuf} src 源画布
   * @param {number} [dx] 目标偏移 x
   * @param {number} [dy] 目标偏移 y
   */
  blit(src, dx = 0, dy = 0) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const c = src.get(x, y);
        if (c[3] === 0) continue;
        this.set(x + dx, y + dy, c);
      }
    }
  }

  /** 矩形 */
  rect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
    }
  }

  /** 横线 */
  hline(x, y, w, color) {
    for (let xx = x; xx < x + w; xx++) this.set(xx, y, color);
  }

  /** 竖线 */
  vline(x, y, h, color) {
    for (let yy = y; yy < y + h; yy++) this.set(x, yy, color);
  }

  /** 圆（实心） */
  circle(cx, cy, r, color) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, color);
      }
    }
  }

  /** 圆环 */
  ring(cx, cy, rOuter, rInner, color) {
    const ro2 = rOuter * rOuter;
    const ri2 = rInner * rInner;
    for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
      for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro2 && d2 >= ri2) this.set(x, y, color);
      }
    }
  }

  /** 椭圆（实心） */
  ellipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, color);
      }
    }
  }

  /** 直线（Bresenham） */
  line(x0, y0, x1, y1, color) {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x, y, color);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /**
   * 给不透明像素的外轮廓描一圈边
   *
   * 像素风的关键一步：所有图形统一一圈深色描边，风格才整齐。
   * 会把图形向外扩 1 像素。
   * @param {string} color 描边色
   */
  outline(color) {
    const targets = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!this.isOpaque(x, y)) continue;
        const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of neighbors) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          if (!this.isOpaque(nx, ny)) targets.push([nx, ny]);
        }
      }
    }
    for (const [x, y] of targets) this.set(x, y, color);
  }

  /**
   * 最近邻放大（整数倍）
   * @param {number} f 倍数
   * @returns {PixBuf}
   */
  scale(f) {
    const out = new PixBuf(this.w * f, this.h * f);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.get(x, y);
        if (c[3] === 0) continue;
        for (let dy = 0; dy < f; dy++) {
          for (let dx = 0; dx < f; dx++) {
            out.set(x * f + dx, y * f + dy, c);
          }
        }
      }
    }
    return out;
  }

  /** 复制一份 */
  clone() {
    const out = new PixBuf(this.w, this.h);
    out.data.set(this.data);
    return out;
  }

  /** 取 RGBA 数据（拷贝一份，避免外部改动） */
  toRGBA() {
    return new Uint8Array(this.data);
  }
}

/**
 * 确定性伪随机数（线性同余）
 *
 * 美术资源是代码生成的，必须保证**每次生成结果一致**，
 * 否则重新跑一次脚本就会产生一堆"看起来没变但字节不同"的资源，
 * git diff 全是噪音。这里用固定种子的 LCG 而不是 Math.random。
 * @param {number} seed 种子
 * @returns {() => number} 返回 [0,1) 的随机函数
 */
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
