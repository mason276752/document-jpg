<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CornerEditor from './components/CornerEditor.vue'
import { call } from './lib/client.js'
import { defaultOptions } from './lib/enhance.js'

const MAX_SOURCE = 4096 // 原圖最長邊上限
const DETECT_SIDE = 512
const PREVIEW_SIDE = 1400
const EXPORT_SIDE = 3508 // A4 @ 300dpi

const MODES = [
  { id: 'color', label: '文件', hint: '去陰影、紙張變白，保留顏色' },
  { id: 'gray', label: '灰階', hint: '去陰影的灰階掃描' },
  { id: 'bw', label: '黑白', hint: '純黑白，適合文字稿' },
  { id: 'original', label: '原圖', hint: '只做透視校正' },
]

const pages = ref([])
const currentId = ref(null)
const view = ref('crop') // crop | enhance
const loading = ref(0)
const processing = ref(false)
const exporting = ref('')
const error = ref('')
const dragOver = ref(false)
const previewCanvas = ref(null)
const fileInput = ref(null)
const cameraInput = ref(null)

const current = computed(() => pages.value.find((p) => p.id === currentId.value))
const mode = computed(() => MODES.find((m) => m.id === current.value?.options.mode))

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
const plainCorners = (p) => p.corners.map((c) => ({ x: c.x, y: c.y }))

function canvasData(source, w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  return { canvas: c, data: ctx.getImageData(0, 0, w, h) }
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  error.value = ''
  loading.value += files.length
  for (const file of files) {
    try {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.src = url
      await img.decode()
      const s = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * s)
      const h = Math.round(img.naturalHeight * s)
      const { canvas, data: full } = canvasData(img, w, h)
      const ds = Math.min(1, DETECT_SIDE / Math.max(w, h))
      const { data: small } = canvasData(canvas, Math.round(w * ds), Math.round(h * ds))

      const id = uid()
      await call('setSource', { id, image: full }, [full.data.buffer])
      const det = await call('detect', { image: small }, [small.data.buffer])
      pages.value.push({
        id,
        name: file.name.replace(/\.[^.]+$/, ''),
        url,
        width: w,
        height: h,
        corners: det.corners,
        autoCorners: det.corners,
        found: det.found,
        rotation: 0,
        options: defaultOptions(),
        thumb: url,
      })
      if (!currentId.value || pages.value.length === 1) {
        currentId.value = id
        view.value = 'crop'
      }
    } catch (e) {
      console.error(e)
      error.value = `無法讀取「${file.name}」：${e.message || e}`
    } finally {
      loading.value--
    }
  }
}

function onPick(e) {
  addFiles(e.target.files)
  e.target.value = ''
}

function onDrop(e) {
  dragOver.value = false
  addFiles(e.dataTransfer.files)
}

function onPaste(e) {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile())
  if (files.length) addFiles(files)
}
onMounted(() => window.addEventListener('paste', onPaste))
onBeforeUnmount(() => window.removeEventListener('paste', onPaste))

function selectPage(id) {
  currentId.value = id
}

function removePage(p) {
  const i = pages.value.indexOf(p)
  pages.value.splice(i, 1)
  call('remove', { id: p.id })
  URL.revokeObjectURL(p.url)
  if (currentId.value === p.id) {
    const next = pages.value[Math.min(i, pages.value.length - 1)]
    currentId.value = next?.id ?? null
    if (!next) view.value = 'crop'
  }
}

function movePage(p, dir) {
  const i = pages.value.indexOf(p), j = i + dir
  if (j < 0 || j >= pages.value.length) return
  const arr = pages.value
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}

function resetCorners(kind) {
  const p = current.value
  if (kind === 'auto') p.corners = p.autoCorners.map((c) => ({ ...c }))
  else p.corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
}

function rotate(dir) {
  const p = current.value
  p.rotation = (p.rotation + dir + 4) % 4
}

function applyToAll() {
  const o = current.value.options
  for (const p of pages.value) p.options = { ...o }
}

// ---------- 預覽：同時只送一個請求，拖滑桿時合併成最新那一筆 ----------
let inflight = false
let queued = false
let timer = 0

function schedulePreview() {
  clearTimeout(timer)
  timer = setTimeout(renderPreview, 40)
}

async function renderPreview() {
  const p = current.value
  if (!p || view.value !== 'enhance') return
  if (inflight) {
    queued = true
    return
  }
  inflight = true
  processing.value = true
  try {
    const img = await call('process', {
      id: p.id,
      corners: plainCorners(p),
      rotation: p.rotation,
      options: { ...p.options },
      maxSide: PREVIEW_SIDE,
      cache: true,
    })
    if (p === current.value && view.value === 'enhance') {
      await nextTick()
      const c = previewCanvas.value
      if (c) {
        c.width = img.width
        c.height = img.height
        c.getContext('2d').putImageData(img, 0, 0)
        p.thumb = thumbnail(c)
      }
    }
  } catch (e) {
    error.value = e.message
  } finally {
    inflight = false
    processing.value = false
    if (queued) {
      queued = false
      renderPreview()
    }
  }
}

function thumbnail(src) {
  const s = 180 / Math.max(src.width, src.height)
  const c = document.createElement('canvas')
  c.width = Math.round(src.width * s)
  c.height = Math.round(src.height * s)
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.75)
}

watch(
  () => current.value && [current.value.id, view.value, current.value.rotation, JSON.stringify(current.value.options)],
  schedulePreview,
)

// ---------- 匯出 ----------
async function renderFull(p) {
  const img = await call('process', {
    id: p.id,
    corners: plainCorners(p),
    rotation: p.rotation,
    options: { ...p.options },
    maxSide: EXPORT_SIDE,
    cache: false,
  })
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d').putImageData(img, 0, 0)
  return c
}

function saveBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q))
const ext = (type) => (type === 'image/png' ? 'png' : 'jpg')

// 可以用系統分享表單存圖（手機上會出現「儲存影像」直接進相簿）
const canShareFiles = (() => {
  try {
    return !!navigator.canShare?.({ files: [new File([''], 'a.jpg', { type: 'image/jpeg' })] })
  } catch {
    return false
  }
})()
const exportMenu = ref(false)
const pendingShare = ref(null) // 算圖太久導致使用者手勢過期時，改成再點一次

async function renderFiles(list, type) {
  const files = []
  for (const [i, p] of list.entries()) {
    exporting.value = list.length > 1 ? `圖片 ${i + 1} / ${list.length}` : '輸出中…'
    const blob = await toBlob(await renderFull(p), type, 0.92)
    const suffix = list.length > 1 ? `-${pages.value.indexOf(p) + 1}` : ''
    files.push(new File([blob], `${p.name}-scan${suffix}.${ext(type)}`, { type }))
  }
  return files
}

async function exportImages(type, scope = 'all') {
  exportMenu.value = false
  const list = scope === 'all' ? pages.value : [current.value]
  try {
    const files = await renderFiles(list, type)
    for (const [i, f] of files.entries()) {
      saveBlob(f, f.name)
      // 連續下載時稍微間隔，避免瀏覽器擋掉
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350))
    }
  } catch (e) {
    error.value = e.message
  } finally {
    exporting.value = ''
  }
}

async function shareImages(scope = 'all') {
  exportMenu.value = false
  const list = scope === 'all' ? pages.value : [current.value]
  try {
    const files = await renderFiles(list, 'image/jpeg')
    exporting.value = ''
    await shareFiles(files)
  } catch (e) {
    error.value = e.message
  } finally {
    exporting.value = ''
  }
}

async function shareFiles(files) {
  try {
    await navigator.share({ files })
    pendingShare.value = null
  } catch (e) {
    if (e.name === 'AbortError') pendingShare.value = null
    else if (e.name === 'NotAllowedError') pendingShare.value = files
    else throw e
  }
}

async function exportPdf() {
  exportMenu.value = false
  exporting.value = '準備 PDF…'
  try {
    const { jsPDF } = await import('jspdf')
    let doc = null
    for (const [i, p] of pages.value.entries()) {
      exporting.value = `PDF ${i + 1} / ${pages.value.length}`
      const c = await renderFull(p)
      const long = 842 // A4 長邊（pt）
      const land = c.width > c.height
      const pw = land ? long : (long * c.width) / c.height
      const ph = land ? (long * c.height) / c.width : long
      const orientation = land ? 'l' : 'p'
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation, compress: true })
      else doc.addPage([pw, ph], orientation)
      doc.addImage(c.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, pw, ph)
    }
    doc.save(`${pages.value[0].name}-scan.pdf`)
  } catch (e) {
    error.value = e.message
  } finally {
    exporting.value = ''
  }
}
</script>

<template>
  <div
    class="app"
    @dragover.prevent="dragOver = true"
    @dragleave.self="dragOver = false"
    @drop.prevent="onDrop"
  >
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" opacity=".85" />
        </svg>
        <span>紙鏡</span>
        <small>網頁文件掃描</small>
      </div>
      <div class="top-actions">
        <button class="btn ghost" @click="cameraInput.click()">拍照</button>
        <button class="btn ghost" @click="fileInput.click()">＋ 加入圖片</button>
        <div class="menu-wrap">
          <button class="btn primary" :disabled="!pages.length || !!exporting" @click="exportMenu = !exportMenu">
            {{ exporting || '匯出 ▾' }}
          </button>
          <div v-if="exportMenu" class="menu-backdrop" @click="exportMenu = false" />
          <div v-if="exportMenu" class="menu">
            <p class="menu-title">全部 {{ pages.length }} 頁</p>
            <button @click="exportPdf"><b>PDF</b><span>合併成一份文件</span></button>
            <button @click="exportImages('image/jpeg')"><b>JPG</b><span>{{ pages.length > 1 ? '每頁一張圖片' : '圖片' }}</span></button>
            <button @click="exportImages('image/png')"><b>PNG</b><span>無損圖片</span></button>
            <button v-if="canShareFiles" @click="shareImages()"><b>存到相簿</b><span>或分享到其他 App</span></button>
          </div>
        </div>
      </div>
      <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onPick" />
      <input ref="cameraInput" type="file" accept="image/*" capture="environment" hidden @change="onPick" />
    </header>

    <p v-if="error" class="error" @click="error = ''">{{ error }}　✕</p>
    <p v-if="pendingShare" class="notice">
      圖片已準備好
      <button class="btn primary" @click="shareFiles(pendingShare)">儲存 / 分享</button>
      <button class="link" @click="pendingShare = null">取消</button>
    </p>

    <!-- 空狀態 -->
    <main v-if="!pages.length" class="empty">
      <div class="drop" :class="{ over: dragOver }" @click="fileInput.click()">
        <div class="drop-icon">
          <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
            <path d="M8 16V8h8M32 8h8v8M40 32v8h-8M16 40H8v-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
            <path d="M17 14h10l5 5v15H17z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
            <path d="M21 24h7M21 29h7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          </svg>
        </div>
        <h1>{{ loading ? '讀取中…' : '把文件照片拖進來' }}</h1>
        <p>或點此選擇圖片、也可以直接貼上（⌘V / Ctrl+V）。<br />自動找出紙張邊緣、拉正、去除手機遮光的陰影。</p>
        <div class="drop-btns" @click.stop>
          <button class="btn primary" @click="fileInput.click()">選擇圖片</button>
          <button class="btn ghost" @click="cameraInput.click()">用相機拍</button>
        </div>
        <p class="note">所有處理都在你的瀏覽器裡完成，圖片不會上傳。</p>
      </div>
    </main>

    <!-- 工作區 -->
    <main v-else class="work">
      <section class="canvas-area">
        <CornerEditor
          v-if="view === 'crop' && current"
          :key="current.id"
          v-model="current.corners"
          :src="current.url"
          :img-w="current.width"
          :img-h="current.height"
        />
        <div v-else class="preview">
          <canvas ref="previewCanvas" />
          <div v-if="processing" class="spinner" />
        </div>
        <div v-if="dragOver" class="drop-hint">放開以加入頁面</div>
      </section>

      <aside v-if="current" class="panel">
        <div class="steps">
          <button :class="{ on: view === 'crop' }" @click="view = 'crop'"><b>1</b> 邊框</button>
          <button :class="{ on: view === 'enhance' }" @click="view = 'enhance'"><b>2</b> 濾鏡</button>
        </div>

        <template v-if="view === 'crop'">
          <h2>調整邊框</h2>
          <p class="muted">
            {{ current.found ? '已自動偵測到紙張，' : '沒有找到明顯的紙張邊緣，' }}拖動四個角或邊的中點微調。
          </p>
          <div class="row">
            <button class="btn ghost" @click="resetCorners('auto')">自動偵測</button>
            <button class="btn ghost" @click="resetCorners('full')">整張圖</button>
          </div>
          <button class="btn primary wide" @click="view = 'enhance'">下一步：濾鏡 →</button>
        </template>

        <template v-else>
          <h2>濾鏡</h2>
          <div class="modes">
            <button v-for="m in MODES" :key="m.id" :class="{ on: current.options.mode === m.id }"
              @click="current.options.mode = m.id">
              <span class="swatch" :class="m.id" />{{ m.label }}
            </button>
          </div>
          <p class="muted">{{ mode?.hint }}</p>

          <div v-if="current.options.mode !== 'original'" class="sliders">
            <label>
              <span>去陰影強度 <em>{{ current.options.shadow }}</em></span>
              <input v-model.number="current.options.shadow" type="range" min="1" max="12" step="1" />
            </label>
            <template v-if="current.options.mode === 'bw'">
              <label>
                <span>黑白閾值 <em>{{ current.options.threshold }}</em></span>
                <input v-model.number="current.options.threshold" type="range" min="40" max="95" step="1" />
              </label>
            </template>
            <template v-else>
              <label>
                <span>亮度 <em>{{ current.options.brightness }}</em></span>
                <input v-model.number="current.options.brightness" type="range" min="0" max="100" step="1" />
              </label>
              <label>
                <span>對比 <em>{{ current.options.contrast }}</em></span>
                <input v-model.number="current.options.contrast" type="range" min="0" max="100" step="1" />
              </label>
              <label>
                <span>銳利度 <em>{{ current.options.sharpen }}</em></span>
                <input v-model.number="current.options.sharpen" type="range" min="0" max="100" step="1" />
              </label>
            </template>
            <button class="link" @click="current.options = { ...defaultOptions(), mode: current.options.mode }">恢復預設值</button>
          </div>

          <div class="row">
            <button class="btn ghost" title="向左旋轉" @click="rotate(-1)">⟲ 左轉</button>
            <button class="btn ghost" title="向右旋轉" @click="rotate(1)">⟳ 右轉</button>
          </div>
          <button v-if="pages.length > 1" class="btn ghost wide" @click="applyToAll">套用到所有頁面</button>

          <div class="export">
            <h3>下載這一頁</h3>
            <div class="row">
              <button class="btn primary" :disabled="!!exporting" @click="exportImages('image/jpeg', 'current')">JPG</button>
              <button class="btn ghost" :disabled="!!exporting" @click="exportImages('image/png', 'current')">PNG</button>
            </div>
            <button v-if="canShareFiles" class="btn ghost wide save-photo" :disabled="!!exporting" @click="shareImages('current')">
              存到相簿 / 分享
            </button>
            <p v-if="exporting === '輸出中…'" class="muted">輸出中…</p>
          </div>
        </template>
      </aside>
    </main>

    <!-- 頁面列 -->
    <footer v-if="pages.length" class="strip">
      <div v-for="(p, i) in pages" :key="p.id" class="thumb" :class="{ on: p.id === currentId }" @click="selectPage(p.id)">
        <img :src="p.thumb" alt="" />
        <span class="num">{{ i + 1 }}</span>
        <div class="thumb-actions" @click.stop>
          <button title="往前" :disabled="i === 0" @click="movePage(p, -1)">‹</button>
          <button title="刪除" @click="removePage(p)">✕</button>
          <button title="往後" :disabled="i === pages.length - 1" @click="movePage(p, 1)">›</button>
        </div>
      </div>
      <button class="thumb add" @click="fileInput.click()">
        <span v-if="loading">…</span><span v-else>＋</span>
      </button>
    </footer>
  </div>
</template>
