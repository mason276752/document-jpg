// 透視校正：把四邊形區域拉成矩形
import { createImage } from './filters.js'

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// 單位正方形 → 任意四邊形的投影變換（Heckbert）
function squareToQuad([p0, p1, p2, p3]) {
  const sx = p0.x - p1.x + p2.x - p3.x
  const sy = p0.y - p1.y + p2.y - p3.y
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return { a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x, d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y, g: 0, h: 0 }
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y
  const den = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / den
  const h = (dx1 * sy - sx * dy1) / den
  return {
    a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x,
    d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y,
    g, h,
  }
}

// corners：來源影像像素座標，順序 左上、右上、右下、左下
export function warp(src, corners, maxSide = Infinity) {
  const [tl, tr, br, bl] = corners
  let W = Math.max(dist(tl, tr), dist(bl, br))
  let H = Math.max(dist(tl, bl), dist(tr, br))
  const s = Math.min(1, maxSide / Math.max(W, H))
  W = Math.max(1, Math.round(W * s))
  H = Math.max(1, Math.round(H * s))
  // 縮小時做超取樣避免文字鋸齒
  const ss = Math.min(3, Math.max(1, Math.round(1 / s)))

  const { a, b, c, d, e, f, g, h } = squareToQuad(corners)
  const out = createImage(W, H)
  const od = out.data, sd = src.data
  const sw = src.width, sh = src.height
  const inv = 1 / (ss * ss)

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, gg = 0, bb = 0
      for (let j = 0; j < ss; j++) {
        const v = (y + (j + 0.5) / ss) / H
        for (let i = 0; i < ss; i++) {
          const u = (x + (i + 0.5) / ss) / W
          const z = g * u + h * v + 1
          let px = (a * u + b * v + c) / z - 0.5
          let py = (d * u + e * v + f) / z - 0.5
          px = px < 0 ? 0 : px > sw - 1 ? sw - 1 : px
          py = py < 0 ? 0 : py > sh - 1 ? sh - 1 : py
          const x0 = px | 0, y0 = py | 0
          const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1)
          const fx = px - x0, fy = py - y0
          const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4
          const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
          r += sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11
          gg += sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11
          bb += sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11
        }
      }
      const o = (y * W + x) * 4
      od[o] = r * inv
      od[o + 1] = gg * inv
      od[o + 2] = bb * inv
      od[o + 3] = 255
    }
  }
  return out
}
