import { detectDocument } from './detect.js'
import { warp } from './warp.js'
import { enhance } from './enhance.js'

// id -> { image, cacheKey, cached }
const sources = new Map()

const rotateCorners = (c, k) => [0, 1, 2, 3].map((i) => c[(i - (k % 4) + 4) % 4])

self.onmessage = (e) => {
  const { reqId, type, payload } = e.data
  try {
    let result = null
    let transfer = []
    if (type === 'detect') {
      result = detectDocument(payload.image)
    } else if (type === 'setSource') {
      sources.set(payload.id, { image: payload.image })
    } else if (type === 'remove') {
      sources.delete(payload.id)
    } else if (type === 'process') {
      const s = sources.get(payload.id)
      if (!s) throw new Error('找不到來源影像')
      const { corners, rotation, options, maxSide, cache } = payload
      const px = corners.map((c) => ({ x: c.x * s.image.width, y: c.y * s.image.height }))
      const key = JSON.stringify([corners, rotation, maxSide])
      let warped = s.cacheKey === key ? s.cached : null
      if (!warped) {
        warped = warp(s.image, rotateCorners(px, rotation), maxSide)
        if (cache) { s.cacheKey = key; s.cached = warped }
      }
      result = enhance(warped, options)
      transfer = [result.data.buffer]
    }
    self.postMessage({ reqId, result }, transfer)
  } catch (err) {
    self.postMessage({ reqId, error: err?.message || String(err) })
  }
}
