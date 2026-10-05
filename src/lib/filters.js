// 共用的基礎影像運算（單通道 Float32Array）

export function createImage(w, h) {
  if (typeof ImageData !== 'undefined') return new ImageData(w, h)
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
}

export const lumAt = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]

// 可分離的方框模糊，邊界以夾取處理
export function boxBlur(src, w, h, r) {
  if (r < 1) return src.slice()
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const k = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / k
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

// 可分離的最大 / 最小值濾波（形態學膨脹 / 侵蝕）
function rankFilter(src, w, h, r, isMax) {
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const pick = isMax ? Math.max : Math.min
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = src[row + x]
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r)
      for (let i = a; i <= b; i++) v = pick(v, src[row + i])
      tmp[row + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r), b = Math.min(h - 1, y + r)
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]
      for (let i = a; i <= b; i++) v = pick(v, tmp[i * w + x])
      out[y * w + x] = v
    }
  }
  return out
}

export const maxFilter = (src, w, h, r) => rankFilter(src, w, h, r, true)
export const minFilter = (src, w, h, r) => rankFilter(src, w, h, r, false)
