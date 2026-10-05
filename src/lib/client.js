const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
const pending = new Map()
let nextId = 1

worker.onmessage = (e) => {
  const { reqId, result, error } = e.data
  const p = pending.get(reqId)
  pending.delete(reqId)
  if (error) p.reject(new Error(error))
  else p.resolve(result)
}

export function call(type, payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const reqId = nextId++
    pending.set(reqId, { resolve, reject })
    worker.postMessage({ reqId, type, payload }, transfer)
  })
}
