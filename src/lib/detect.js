// 自動偵測文件四個角（在縮小過的影像上執行）
// 兩種候選：亮度分割（紙張比背景亮）與邊緣封閉區域，挑最像四邊形的那個。
import { boxBlur, lumAt } from './filters.js'

export function detectDocument(img) {
  const { width: w, height: h, data } = img
  const n = w * h
  let g = new Float32Array(n)
  for (let i = 0; i < n; i++) g[i] = lumAt(data, i * 4)
  g = boxBlur(boxBlur(g, w, h, 2), w, h, 2)

  const candidates = []

  // A. 亮度分割
  const t = otsu(g)
  const maskA = new Uint8Array(n)
  for (let i = 0; i < n; i++) maskA[i] = g[i] > t ? 1 : 0
  {
    const { labels, info } = components(maskA, w, h)
    const best = info.reduce((a, b) => (b && (!a || b.size > a.size) ? b : a), null)
    const c = best && makeCandidate(labels, best, w, h)
    if (c) {
      const solidity = best.size / c.hullArea
      c.score = c.rect * Math.min(1, solidity + 0.1) - (best.sides >= 3 ? 0.3 : 0)
      candidates.push(c)
    }
  }

  // B. 邊緣封閉區域
  const mag = sobel(g, w, h)
  const thr = Math.max(18, quantile(mag, 0.9))
  const edge = new Uint8Array(n)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (mag[y * w + x] > thr) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) edge[(y + dy) * w + x + dx] = 1
      }
    }
  }
  const maskB = new Uint8Array(n)
  for (let i = 0; i < n; i++) maskB[i] = edge[i] ? 0 : 1
  {
    const { labels, info } = components(maskB, w, h)
    const best = info.reduce((a, b) => (b && b.sides <= 1 && (!a || b.size > a.size) ? b : a), null)
    const c = best && makeCandidate(labels, best, w, h)
    if (c) {
      // 邊緣經過膨脹，內部區域略小於紙張，往外推回一點
      expand(c.quad, 2.5)
      c.score = c.rect
      candidates.push(c)
    }
  }

  const valid = candidates
    .filter((c) => c.frac > 0.08 && c.frac < 0.985 && c.rect > 0.85)
    .sort((a, b) => b.score + b.frac * 0.2 - (a.score + a.frac * 0.2))

  if (!valid.length) {
    const m = 0.04
    return { found: false, corners: [{ x: m, y: m }, { x: 1 - m, y: m }, { x: 1 - m, y: 1 - m }, { x: m, y: 1 - m }] }
  }
  const corners = orderCorners(valid[0].quad).map(([x, y]) => ({
    x: Math.min(1, Math.max(0, x / w)),
    y: Math.min(1, Math.max(0, y / h)),
  }))
  return { found: true, corners }
}

function makeCandidate(labels, comp, w, h) {
  const pts = []
  const L = comp.label
  for (let y = comp.minY; y <= comp.maxY; y++) {
    for (let x = comp.minX; x <= comp.maxX; x++) {
      const i = y * w + x
      if (labels[i] !== L) continue
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        labels[i - 1] !== L || labels[i + 1] !== L || labels[i - w] !== L || labels[i + w] !== L) {
        pts.push([x + 0.5, y + 0.5])
      }
    }
  }
  const hull = convexHull(pts)
  const quad = maxQuad(hull)
  if (!quad) return null
  const hullArea = polyArea(hull)
  const quadArea = polyArea(quad)
  return { quad, hullArea, rect: quadArea / hullArea, frac: quadArea / (w * h) }
}

function otsu(g) {
  const hist = new Float64Array(256)
  for (let i = 0; i < g.length; i++) hist[Math.min(255, g[i] | 0)]++
  const total = g.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, best = 0, t = 127
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) ** 2
    if (v > best) { best = v; t = i }
  }
  return t
}

function sobel(g, w, h) {
  const m = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1]
      const d = g[i - 1], f = g[i + 1]
      const p = g[i + w - 1], q = g[i + w], r = g[i + w + 1]
      m[i] = Math.abs(c + 2 * f + r - a - 2 * d - p) + Math.abs(p + 2 * q + r - a - 2 * b - c)
    }
  }
  return m
}

function quantile(arr, q) {
  const sample = []
  for (let i = 0; i < arr.length; i += 5) sample.push(arr[i])
  sample.sort((a, b) => a - b)
  return sample[Math.floor(q * (sample.length - 1))] || 0
}

function components(mask, w, h) {
  const n = w * h
  const labels = new Int32Array(n)
  const stack = new Int32Array(n)
  const info = [null]
  let L = 0
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue
    L++
    let sp = 0, size = 0, minX = w, maxX = 0, minY = h, maxY = 0
    stack[sp++] = s
    labels[s] = L
    while (sp) {
      const j = stack[--sp]
      const x = j % w, y = (j / w) | 0
      size++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && mask[j - 1] && !labels[j - 1]) { labels[j - 1] = L; stack[sp++] = j - 1 }
      if (x < w - 1 && mask[j + 1] && !labels[j + 1]) { labels[j + 1] = L; stack[sp++] = j + 1 }
      if (y > 0 && mask[j - w] && !labels[j - w]) { labels[j - w] = L; stack[sp++] = j - w }
      if (y < h - 1 && mask[j + w] && !labels[j + w]) { labels[j + w] = L; stack[sp++] = j + w }
    }
    const sides = (minX === 0) + (maxX === w - 1) + (minY === 0) + (maxY === h - 1)
    info.push({ label: L, size, minX, maxX, minY, maxY, sides })
  }
  return { labels, info }
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const tri = (a, b, c) => Math.abs(cross(a, b, c)) / 2

function convexHull(pts) {
  if (pts.length < 3) return pts
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lower = [], upper = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

// 凸多邊形內接最大四邊形，O(n²)
function maxQuad(P) {
  const n = P.length
  if (n < 4) return null
  const at = (i) => P[i % n]
  let best = -1, bq = null
  for (let i = 0; i < n; i++) {
    let j = i + 1, l = i + 3
    for (let k = i + 2; k <= i + n - 2; k++) {
      if (j >= k) j = k - 1
      while (j + 1 < k && tri(at(i), at(j + 1), at(k)) >= tri(at(i), at(j), at(k))) j++
      if (l <= k) l = k + 1
      while (l + 1 < i + n && tri(at(i), at(k), at(l + 1)) >= tri(at(i), at(k), at(l))) l++
      const a = tri(at(i), at(j), at(k)) + tri(at(i), at(k), at(l))
      if (a > best) { best = a; bq = [at(i), at(j), at(k), at(l)] }
    }
  }
  return bq.map((p) => [p[0], p[1]])
}

function polyArea(P) {
  let a = 0
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a) / 2
}

function expand(quad, d) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4
  for (const p of quad) {
    const dx = p[0] - cx, dy = p[1] - cy
    const len = Math.hypot(dx, dy) || 1
    p[0] += (dx / len) * d
    p[1] += (dy / len) * d
  }
}

// 排成 左上、右上、右下、左下
export function orderCorners(quad) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4
  const sorted = [...quad].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
  let start = 0
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = i })
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4])
}
