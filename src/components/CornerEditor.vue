<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  src: { type: String, required: true },
  imgW: { type: Number, required: true },
  imgH: { type: Number, required: true },
  modelValue: { type: Array, required: true }, // 4 個正規化座標 {x,y}：左上、右上、右下、左下
})
const emit = defineEmits(['update:modelValue'])

const wrap = ref(null)
const stage = ref(null)
const box = ref({ w: 0, h: 0 })
const drag = ref(null) // { kind: 'c'|'e', index, offset, start }

const LOUPE = 128
const ZOOM = 3

let ro
onMounted(() => {
  ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    box.value = { w: width, h: height }
  })
  ro.observe(wrap.value)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  endDrag()
})

const pad = 28
const scale = computed(() => {
  const s = Math.min((box.value.w - pad * 2) / props.imgW, (box.value.h - pad * 2) / props.imgH)
  return Math.max(0.01, s)
})
const dw = computed(() => Math.round(props.imgW * scale.value))
const dh = computed(() => Math.round(props.imgH * scale.value))

const pts = computed(() => props.modelValue.map((c) => ({ x: c.x * dw.value, y: c.y * dh.value })))
const poly = computed(() => pts.value.map((p) => `${p.x},${p.y}`).join(' '))
const mids = computed(() =>
  pts.value.map((p, i) => {
    const q = pts.value[(i + 1) % 4]
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
  }),
)

const clamp01 = (v) => Math.min(1, Math.max(0, v))

function pointer(e) {
  const r = stage.value.getBoundingClientRect()
  return { x: (e.clientX - r.left) / dw.value, y: (e.clientY - r.top) / dh.value }
}

function startDrag(e, kind, index) {
  e.preventDefault()
  const p = pointer(e)
  const anchor = kind === 'c' ? props.modelValue[index] : null
  drag.value = {
    kind,
    index,
    offset: anchor ? { x: anchor.x - p.x, y: anchor.y - p.y } : null,
    last: p,
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
}

function onMove(e) {
  const d = drag.value
  if (!d) return
  const p = pointer(e)
  const next = props.modelValue.map((c) => ({ ...c }))
  if (d.kind === 'c') {
    next[d.index] = { x: clamp01(p.x + d.offset.x), y: clamp01(p.y + d.offset.y) }
  } else {
    // 拖邊：兩個端點一起平移
    const a = d.index, b = (d.index + 1) % 4
    let dx = p.x - d.last.x, dy = p.y - d.last.y
    for (const i of [a, b]) {
      dx = Math.min(Math.max(dx, -next[i].x), 1 - next[i].x)
      dy = Math.min(Math.max(dy, -next[i].y), 1 - next[i].y)
    }
    for (const i of [a, b]) next[i] = { x: next[i].x + dx, y: next[i].y + dy }
    d.last = p
  }
  emit('update:modelValue', next)
}

function endDrag() {
  drag.value = null
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
}

// 放大鏡：對準正在拖的角或邊中點
const focus = computed(() => {
  const d = drag.value
  if (!d) return null
  return d.kind === 'c' ? pts.value[d.index] : mids.value[d.index]
})
const loupeStyle = computed(() => {
  const f = focus.value
  if (!f) return {}
  // 手指在左上角附近時，放大鏡移到右上
  const right = f.x < LOUPE * 1.4 && f.y < LOUPE * 1.4
  return { [right ? 'right' : 'left']: '12px' }
})
const loupeBox = computed(() => {
  const f = focus.value
  if (!f) return ''
  const s = LOUPE / ZOOM
  return `${f.x - s / 2} ${f.y - s / 2} ${s} ${s}`
})
</script>

<template>
  <div ref="wrap" class="editor">
    <div ref="stage" class="stage" :style="{ width: dw + 'px', height: dh + 'px' }">
      <img :src="src" alt="" draggable="false" />
      <svg class="overlay" :viewBox="`0 0 ${dw} ${dh}`" :width="dw" :height="dh">
        <path
          class="shade"
          fill-rule="evenodd"
          :d="`M0 0H${dw}V${dh}H0Z M${poly.replaceAll(' ', ' L')}Z`"
        />
        <polygon class="outline" :points="poly" />
        <g v-for="(m, i) in mids" :key="'m' + i" class="mid" :class="{ active: drag?.kind === 'e' && drag.index === i }"
          @pointerdown="startDrag($event, 'e', i)">
          <circle :cx="m.x" :cy="m.y" r="20" class="hit" />
          <circle :cx="m.x" :cy="m.y" r="6" class="dot" />
        </g>
        <g v-for="(p, i) in pts" :key="'c' + i" class="corner" :class="{ active: drag?.kind === 'c' && drag.index === i }"
          @pointerdown="startDrag($event, 'c', i)">
          <circle :cx="p.x" :cy="p.y" r="24" class="hit" />
          <circle :cx="p.x" :cy="p.y" r="10" class="dot" />
        </g>
      </svg>
    </div>

    <div v-if="focus" class="loupe" :style="loupeStyle">
      <svg :viewBox="loupeBox" :width="LOUPE" :height="LOUPE">
        <image :href="src" x="0" y="0" :width="dw" :height="dh" preserveAspectRatio="none" />
        <polygon class="outline" :points="poly" :style="{ strokeWidth: 2 / ZOOM }" />
      </svg>
      <span class="cross" />
    </div>
  </div>
</template>

<style scoped>
.editor {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
.stage {
  position: relative;
}
.stage img {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 2px;
  pointer-events: none;
}
.overlay {
  position: absolute;
  inset: 0;
  overflow: visible;
}
.shade {
  fill: rgba(10, 12, 16, 0.55);
  pointer-events: none;
}
.outline {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linejoin: round;
  pointer-events: none;
}
.hit {
  fill: transparent;
  cursor: grab;
}
.corner .dot {
  fill: #fff;
  stroke: var(--accent);
  stroke-width: 3;
  pointer-events: none;
  transition: r 0.12s;
}
.mid .dot {
  fill: var(--accent);
  stroke: #fff;
  stroke-width: 2;
  pointer-events: none;
}
.corner.active .dot {
  r: 13;
}
.active .hit {
  cursor: grabbing;
}
.loupe {
  position: absolute;
  top: 12px;
  width: 128px;
  height: 128px;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  background: #000;
  pointer-events: none;
}
.loupe svg {
  display: block;
}
.cross::before,
.cross::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  background: var(--accent);
}
.cross::before {
  width: 18px;
  height: 2px;
  transform: translate(-50%, -50%);
}
.cross::after {
  width: 2px;
  height: 18px;
  transform: translate(-50%, -50%);
}
</style>
