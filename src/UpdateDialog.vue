<script setup>
import { computed } from 'vue'

const props = defineProps({
  open: Boolean,
  currentVersion: { type: String, default: '' },
  state: { type: Object, default: () => ({ status: 'idle' }) },
  error: { type: String, default: '' },
  busy: Boolean,
  packaged: Boolean,
  confirmOpen: Boolean,
})
const emit = defineEmits(['close', 'minimize', 'update-now', 'cancel-update', 'recheck', 'confirm-close', 'confirm-install'])

const statusText = computed(() => ({
  idle: '点击检查更新',
  checking: '正在检查更新…',
  available: '发现新版本',
  'up-to-date': '已是最新版本',
  testing: '正在测速加速源…',
  downloading: '正在下载更新…',
  ready: '更新已下载',
  installing: '正在重启安装…',
  error: '检查或下载失败',
}[props.state.status] || ''))

const format = computed(() => props.state.asset?.format === 'full' ? 'full' : 'asar')
const showUpdate = computed(() => ['available', 'testing', 'downloading', 'ready', 'installing'].includes(props.state.status))
const showError = computed(() => props.error || props.state.error || '')
const noteItems = computed(() => {
  const lines = String(props.state.notes || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length && lines[0].includes(props.state.version || '') && /正式版|更新/.test(lines[0])) lines.shift()
  return lines.map(line => line.replace(/^[-*]\s+/, '')).filter(Boolean)
})
const speedText = computed(() => {
  const bps = Number(props.state.speed) || 0
  if (!bps) return ''
  return bps >= 1024 * 1024 ? (bps / 1024 / 1024).toFixed(1) + ' MB/s' : Math.max(1, Math.round(bps / 1024)) + ' KB/s'
})
const checking = computed(() => props.state.status === 'checking')
const testing = computed(() => props.state.status === 'testing')
const downloading = computed(() => props.state.status === 'downloading')
const ready = computed(() => props.state.status === 'ready')
const installing = computed(() => props.state.status === 'installing')
const actionLabel = computed(() => {
  if (checking.value) return '正在检查…'
  if (testing.value) return '正在测速…'
  if (downloading.value) return `下载中 ${props.state.progress || 0}%`
  if (installing.value) return '正在安装…'
  if (ready.value && format.value === 'full') return '需手动替换'
  if (ready.value && !props.packaged) return '下载完成'
  if (ready.value) return '重启安装'
  return '立即更新'
})
const actionDisabled = computed(() => checking.value || testing.value || downloading.value || installing.value || (ready.value && (format.value === 'full' || !props.packaged)))
const canCancel = computed(() => ['checking', 'testing', 'downloading', 'installing'].includes(props.state.status))
const canRecheck = computed(() => ['idle', 'up-to-date', 'error', 'available'].includes(props.state.status))

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
function formatSize(value) {
  const size = Number(value) || 0
  if (size < 1024 * 1024) return (size / 1024).toFixed(0) + ' KB'
  return (size / 1024 / 1024).toFixed(1) + ' MB'
}
function updateNow() {
  if (!actionDisabled.value) emit('update-now')
}
function leftAction() {
  if (canCancel.value) emit('cancel-update')
  else emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="um-overlay">
      <section class="um-dialog update-dialog" role="dialog" aria-modal="true">
        <button class="um-minimize" type="button" aria-label="最小化" title="最小化" @click="emit('minimize')"><span class="um-minimize-icon"></span></button>
        <button class="um-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2>软件更新</h2>
        <p class="update-sub">当前版本 v{{ currentVersion || '—' }}</p>

        <div class="update-status">
          <b>{{ statusText }}</b>
          <span v-if="state.source">· {{ state.source }}</span>
          <span v-if="speedText" class="settings-muted">· {{ speedText }}</span>
          <span v-if="state.checkedAt" class="settings-muted">上次检查 {{ formatTime(state.checkedAt) }}</span>
          <button v-if="canRecheck" type="button" class="update-recheck" :disabled="busy" @click="emit('recheck')">重新检查</button>
        </div>

        <div v-if="showUpdate" class="update-box">
          <div class="update-versionline">
            <b>v{{ state.version }}</b>
            <span v-if="state.asset">{{ format === 'full' ? '整包' : 'app.asar' }} · {{ formatSize(state.asset.size) }}</span>
          </div>
          <ol v-if="noteItems.length" class="update-list">
            <li v-for="item in noteItems" :key="item">{{ item }}</li>
          </ol>
          <div v-if="downloading" class="update-progress"><i :style="{ width: (state.progress || 0) + '%' }"></i></div>
          <p v-if="downloading" class="update-progress-text">{{ state.progress || 0 }}%</p>
          <p v-if="format === 'full'" class="settings-muted">整包更新暂不支持应用内安装，请下载后手动替换 runtime。</p>
          <p v-else-if="state.status === 'ready' && !packaged" class="settings-muted">开发模式下不执行替换安装。</p>
          <p v-if="showError" class="form-error">{{ showError }}</p>
        </div>

        <div v-else-if="state.status === 'up-to-date'" class="update-empty">
          <p>已是最新版本。</p>
        </div>
        <div v-else-if="state.status === 'checking'" class="update-empty">
          <p>正在检查更新…</p>
        </div>
        <div v-else class="update-empty">
          <p>{{ showError || '点击下方按钮检查是否有新版本。' }}</p>
        </div>

        <div class="um-dialog-actions">
          <button type="button" @click="leftAction">{{ canCancel ? '取消更新' : '下次再说' }}</button>
          <button v-if="state.status !== 'up-to-date'" type="button" class="um-primary" :disabled="busy || actionDisabled" @click="updateNow">{{ actionLabel }}</button>
        </div>
      </section>
    </div>
    <div v-if="open && confirmOpen" class="um-overlay update-confirm-overlay">
      <section class="um-dialog ssh-confirm-dialog" role="dialog" aria-modal="true">
        <h2>重启并安装</h2>
        <p>更新 v{{ state.version }} 已下载。是否立即重启并安装？正在运行的终端和文件传输会中断。</p>
        <div class="um-dialog-actions">
          <button type="button" @click="emit('confirm-close')">稍后</button>
          <button type="button" class="um-primary" :disabled="busy" @click="emit('confirm-install')">立即重启</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
