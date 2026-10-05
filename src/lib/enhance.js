// 去陰影 + 掃描化
// 原理：在低解析度下用形態學閉運算（先膨脹再侵蝕）把文字抹掉，得到「紙張在當下光線下的顏色」，
// 再把原圖除以這張背景圖，光照不均與陰影就被抵消，紙張變成均勻的白。
import { boxBlur, createImage, lumAt, maxFilter, minFilter } from './filters.js'

const BG_LONG = 400

export const defaultOptions = () => ({
  mode: 'color', // original | color | gray | bw
  shadow: 4,
  brightness: 50,
  contrast: 50,
  sharpen: 30,
  threshold: 72,
})

export function enhance(src, o) {
  const { width: w, height: h, data: s } = src
  const out = createImage(w, h)
  const d = out.data
  if (o.mode === 'original') {
    d.set(s)
    return out
  }

  const gray = o.mode !== 'color'
  const ch = gray ? 1 : 3
  const bg = estimateBackground(s, w, h, ch, o.shadow)

  const wp = 1 - o.brightness * 0.003 // 白點：越亮，越早被推成純白
  const bp = o.contrast * 0.005 // 黑點：越高，文字越黑
  const scale = 1 / Math.max(0.05, wp - bp)
  const t = o.threshold / 100

  const { sw, sh, f, planes } = bg
  const xs0 = new Int32Array(w), xs1 = new Int32Array(w), xf = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const u = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5))
    xs0[x] = u | 0
    xs1[x] = Math.min(sw - 1, xs0[x] + 1)
    xf[x] = u - xs0[x]
  }

  for (let y = 0; y < h; y++) {
    const v = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5))
    const r0 = (v | 0) * sw, r1 = Math.min(sh - 1, (v | 0) + 1) * sw, fy = v - (v | 0)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const a = xs0[x], b = xs1[x], fx = xf[x]
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
      if (gray) {
        const p = planes[0]
        const bgv = p[r0 + a] * w00 + p[r0 + b] * w10 + p[r1 + a] * w01 + p[r1 + b] * w11
        const ratio = lumAt(s, i) / Math.max(bgv, 8)
        let val
        if (o.mode === 'bw') {
          const k = (ratio - (t - 0.05)) * 10
          val = k <= 0 ? 0 : k >= 1 ? 255 : k * 255
        } else {
          val = (ratio - bp) * scale * 255
        }
        d[i] = d[i + 1] = d[i + 2] = val
      } else {
        for (let c = 0; c < 3; c++) {
          const p = planes[c]
          const bgv = p[r0 + a] * w00 + p[r0 + b] * w10 + p[r1 + a] * w01 + p[r1 + b] * w11
          d[i + c] = (s[i + c] / Math.max(bgv, 8) - bp) * scale * 255
        }
      }
      d[i + 3] = 255
    }
  }

  if (o.mode !== 'bw' && o.sharpen > 0) sharpen(d, w, h, o.sharpen / 100)
  return out
}

function estimateBackground(s, w, h, ch, strength) {
  const f = Math.max(1, Math.max(w, h) / BG_LONG)
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f)
  const m = sw * sh
  let planes = [new Float32Array(m), new Float32Array(m), new Float32Array(m)]
  const cnt = new Float32Array(m)
  const col = new Int32Array(w)
  for (let x = 0; x < w; x++) col[x] = Math.min(sw - 1, (x / f) | 0)

  for (let y = 0; y < h; y++) {
    const row = Math.min(sh - 1, (y / f) | 0) * sw
    for (let x = 0; x < w; x++) {
      const k = row + col[x], i = (y * w + x) * 4
      planes[0][k] += s[i]; planes[1][k] += s[i + 1]; planes[2][k] += s[i + 2]
      cnt[k]++
    }
  }

  // 1. 閉運算：去掉比 r 小的深色筆畫（文字）
  const r = Math.max(1, Math.round(strength))
  planes = planes.map((p) => {
    for (let k = 0; k < m; k++) p[k] /= cnt[k] || 1
    return minFilter(maxFilter(p, sw, sh, r), sw, sh, r)
  })

  // 2. 大面積色塊 / 黑塊不是紙：與周圍紙張的色度差太多、或暗太多，標記後用周圍紙色補上
  const lum = new Float32Array(m)
  for (let k = 0; k < m; k++) lum[k] = 0.299 * planes[0][k] + 0.587 * planes[1][k] + 0.114 * planes[2][k]
  const R = Math.max(4, Math.round(Math.max(sw, sh) / 10))
  const env = boxBlur(maxFilter(lum, sw, sh, R), sw, sh, R)
  // 紙張色度：取最亮的那批格子的平均
  const sorted = Float32Array.from(lum).sort()
  const bright = sorted[Math.floor(m * 0.8)]
  let pr = 0, pg = 0, pb = 0, pn = 0
  for (let k = 0; k < m; k++) {
    if (lum[k] < bright) continue
    pr += planes[0][k]; pg += planes[1][k]; pb += planes[2][k]; pn++
  }
  const ps = pr + pg + pb || 1
  const cr = pr / ps, cg = pg / ps
  const valid = new Uint8Array(m)
  let invalid = 0
  for (let k = 0; k < m; k++) {
    const sum = planes[0][k] + planes[1][k] + planes[2][k] || 1
    const chroma = Math.abs(planes[0][k] / sum - cr) + Math.abs(planes[1][k] / sum - cg)
    const ok = chroma < 0.06 && lum[k] > env[k] * 0.3
    valid[k] = ok ? 1 : 0
    if (!ok) invalid++
  }
  if (invalid > 0 && invalid < m * 0.85) inpaint(planes, valid, sw, sh)

  // 3. 輕微平滑
  planes = planes.map((p) => boxBlur(boxBlur(p, sw, sh, 1), sw, sh, 1))
  if (ch === 1) {
    const g = new Float32Array(m)
    for (let k = 0; k < m; k++) g[k] = 0.299 * planes[0][k] + 0.587 * planes[1][k] + 0.114 * planes[2][k]
    planes = [g]
  }
  return { sw, sh, f, planes }
}

// 由外往內一圈一圈用有效鄰居的平均填補無效格子
function inpaint(planes, valid, w, h) {
  let frontier = true
  while (frontier) {
    frontier = false
    const next = valid.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x
        if (valid[k]) continue
        let n = 0, a = 0, b = 0, c = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= w) continue
            const j = yy * w + xx
            if (!valid[j]) continue
            a += planes[0][j]; b += planes[1][j]; c += planes[2][j]; n++
          }
        }
        if (n) {
          planes[0][k] = a / n; planes[1][k] = b / n; planes[2][k] = c / n
          next[k] = 1
          frontier = true
        }
      }
    }
    valid.set(next)
  }
}

// 反銳化遮罩（4 鄰域），半徑隨解析度放大，預覽與輸出觀感一致
function sharpen(d, w, h, amount) {
  const r = Math.max(1, Math.round(Math.max(w, h) / 1500))
  const src = d.slice()
  const amt = amount * 1.2
  for (let y = 0; y < h; y++) {
    const yu = Math.max(0, y - r) * w, yd = Math.min(h - 1, y + r) * w, yc = y * w
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - r), xr = Math.min(w - 1, x + r)
      const i = (yc + x) * 4
      const iu = (yu + x) * 4, id = (yd + x) * 4, il = (yc + xl) * 4, ir = (yc + xr) * 4
      for (let c = 0; c < 3; c++) {
        const v = src[i + c]
        const m = (src[iu + c] + src[id + c] + src[il + c] + src[ir + c]) * 0.25
        d[i + c] = v + (v - m) * amt
      }
    }
  }
}
