<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  sessionId: { type: String, required: true },
  server: { type: Object, required: true },
})
const emit = defineEmits(['notice'])

const api = window.shellDeck.sftp
const filePath = ref('')
const filePathInput = ref('')
const fileEntries = ref([])
const fileBusy = ref(false)
const fileError = ref('')
const fileSudo = ref(false)
const fileDragActive = ref(false)
const filePerm = ref(null)
const connectState = ref('connecting')
const transfers = ref([])
const editor = ref({ open: false, path: '', name: '', content: '', busy: false })
const nameDialog = ref({ open: false, title: '', value: '', action: null })
const deleteFile = ref(null)
const permDialog = ref({ open: false, path: '', name: '', dir: false, current: '', mode: '', recursive: false, busy: false, error: '' })
const conflict = ref(null)
const fileMenu = ref(null)
const clipboard = ref(null)
const overwriteDialog = ref(null)
let unsubscribers = []
let transferTimers = new Map()

const fileParent = computed(() => {
  if (!filePath.value || filePath.value === '/') return ''
  return filePath.value.replace(/\/[^/]+$/, '') || '/'
})
const fileCrumbs = computed(() => {
  const current = filePath.value || '/'
  if (current === '/') return []
  return current.split('/').filter(Boolean).map((name, index, parts) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))
})
const sortedEntries = computed(() => [...fileEntries.value].sort((a, b) => {
  if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN')
}))
const activeTransfers = computed(() => transfers.value.filter(item => !item.done))

function notify(message) { emit('notice', message) }
function newId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
function closeFileMenu() { fileMenu.value = null }
function menuTargetInside(event) {
  return event.target instanceof Element && Boolean(event.target.closest('.context-menu'))
}
function closeFileMenuOutside(event) {
  if (!fileMenu.value || menuTargetInside(event)) return
  closeFileMenu()
}
function closeFileMenuEscape(event) {
  if (event.key === 'Escape') closeFileMenu()
}
function unbindFileMenu() {
  window.removeEventListener('mousedown', closeFileMenuOutside, true)
  window.removeEventListener('contextmenu', closeFileMenuOutside, true)
  window.removeEventListener('keydown', closeFileMenuEscape)
  window.removeEventListener('blur', closeFileMenu)
  window.removeEventListener('resize', closeFileMenu)
  window.removeEventListener('wheel', closeFileMenu, true)
}
watch(fileMenu, menu => {
  unbindFileMenu()
  if (!menu) return
  window.addEventListener('mousedown', closeFileMenuOutside, true)
  window.addEventListener('contextmenu', closeFileMenuOutside, true)
  window.addEventListener('keydown', closeFileMenuEscape)
  window.addEventListener('blur', closeFileMenu)
  window.addEventListener('resize', closeFileMenu)
  window.addEventListener('wheel', closeFileMenu, true)
})
function openFileMenu(event, entry) {
  if (connectState.value !== 'ready') return
  const width = 220
  const height = entry ? 390 : 220
  fileMenu.value = {
    entry,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  }
}
function copyEntry(entry, mode) {
  clipboard.value = { mode, path: joinPath(entry.name), name: entry.name, type: entry.type }
  notify(mode === 'copy' ? `已复制 ${entry.name}` : `已剪切 ${entry.name}`)
  closeFileMenu()
}
async function copyEntryPath(entry) {
  try {
    await window.shellDeck.clipboard.write(joinPath(entry.name))
    notify('路径已复制')
  } catch {
    notify('复制路径失败')
  }
  closeFileMenu()
}
async function refreshFiles() {
  closeFileMenu()
  await loadFiles(filePath.value)
}
async function runWithOverwrite(label, action, after) {
  fileBusy.value = true
  try {
    await action(false)
    await after()
  } catch (error) {
    if (/目标已存在/.test(String(error.message))) {
      overwriteDialog.value = {
        label,
        run: async () => {
          fileBusy.value = true
          try {
            await action(true)
            await after()
          } catch (next) {
            notify(next.message || `${label}失败`)
          } finally {
            fileBusy.value = false
          }
        },
      }
      return
    }
    notify(error.message || `${label}失败`)
  } finally {
    fileBusy.value = false
  }
}
function uniqueCopyName(name, type) {
  const existing = new Set(fileEntries.value.map(item => item.name))
  let base = name
  let extension = ''
  if (type !== 'dir') {
    const dot = name.lastIndexOf('.')
    if (dot > 0) {
      base = name.slice(0, dot)
      extension = name.slice(dot)
    }
  }
  let candidate = `${base} - 副本${extension}`
  let index = 2
  while (existing.has(candidate)) {
    candidate = `${base} - 副本 (${index})${extension}`
    index += 1
  }
  return candidate
}
function pasteClipboard() {
  const clip = clipboard.value
  closeFileMenu()
  if (!clip) return
  let name = clip.name
  let target = joinPath(name)
  if (clip.path === target) {
    if (clip.mode === 'cut') {
      notify('该文件已经在当前目录')
      return
    }
    name = uniqueCopyName(clip.name, clip.type)
    target = joinPath(name)
  }
  runWithOverwrite('粘贴', overwrite => clip.mode === 'cut'
    ? api.move(props.sessionId, clip.path, target, overwrite)
    : api.copy(props.sessionId, clip.path, target, overwrite), async () => {
    if (clip.mode === 'cut') clipboard.value = null
    await loadFiles(filePath.value)
    notify(clip.mode === 'cut' ? '已移动' : `已粘贴为 ${name}`)
  })
}
function moveEntry(entry) {
  closeFileMenu()
  askName('移动到（完整路径）', joinPath(entry.name), async target => {
    const value = String(target || '').trim()
    if (!value) return
    await runWithOverwrite('移动', overwrite => api.move(props.sessionId, joinPath(entry.name), value, overwrite), async () => {
      await loadFiles(filePath.value)
      notify('已移动')
    })
  })
}
function confirmOverwrite() {
  const pending = overwriteDialog.value
  overwriteDialog.value = null
  if (pending) pending.run()
}
function joinPath(name) {
  const base = filePath.value || '/'
  if (!name) return base
  return base.endsWith('/') ? base + name : base + '/' + name
}
function localSudoKey() { return 'shelldeck-sudo-' + props.server.id }

async function connectFiles() {
  closeFileMenu()
  closeFileSession()
  fileEntries.value = []
  filePerm.value = null
  filePath.value = ''
  filePathInput.value = ''
  fileError.value = ''
  connectState.value = 'connecting'
  fileBusy.value = true
  try {
    const info = await api.connect({ sessionId: props.sessionId, server: JSON.parse(JSON.stringify(props.server)), sudo: fileSudo.value })
    connectState.value = 'ready'
    await loadFiles(info.home)
    if (fileSudo.value) notify('已切换到 root 文件模式')
  } catch (error) {
    fileError.value = error.message || '连接失败'
    connectState.value = 'error'
  } finally {
    fileBusy.value = false
  }
}

function closeFileSession() {
  api.close(props.sessionId).catch(() => {})
}

async function loadFiles(target) {
  closeFileMenu()
  if (connectState.value !== 'ready') return
  fileBusy.value = true
  fileError.value = ''
  fileEntries.value = []
  try {
    const data = await api.list(props.sessionId, target || filePath.value || '/')
    filePath.value = data.path || target || '/'
    filePathInput.value = filePath.value
    filePerm.value = data.perm === undefined || data.perm === null ? null : Number(data.perm)
    fileEntries.value = Array.isArray(data.entries) ? data.entries : []
  } catch (error) {
    fileError.value = error.message || '读取目录失败'
    filePathInput.value = filePath.value
  } finally {
    fileBusy.value = false
  }
}

function goPath() {
  const value = filePathInput.value.trim()
  if (!value) { filePathInput.value = filePath.value; return }
  loadFiles(value.startsWith('/') ? value : joinPath(value))
}
function enterEntry(entry) {
  if (entry.type === 'dir') loadFiles(joinPath(entry.name))
}

async function toggleSudo(event) {
  const value = Boolean(event.target.checked)
  fileSudo.value = value
  try { localStorage.setItem(localSudoKey(), value ? '1' : '0') } catch { /* Storage can be unavailable. */ }
  await connectFiles()
}

async function downloadFile(entry) {
  const transferId = newId()
  try {
    notify('已开始下载 ' + entry.name)
    const result = await api.download({
      sessionId: props.sessionId,
      transferId,
      remotePath: joinPath(entry.name),
      defaultName: entry.name,
    })
    if (!result || result.canceled) notify('已取消下载')
    else notify('已保存到 ' + result.savePath)
  } catch (error) {
    notify(error.message || '下载失败')
  }
}

async function pickUpload() {
  const paths = await window.shellDeck.dialog.pickFiles()
  await uploadPaths(paths)
}
async function pickFolder() {
  const folder = await window.shellDeck.dialog.pickFolder()
  if (folder) await uploadPaths([folder])
}

async function uploadPaths(paths) {
  if (!paths || !paths.length) return
  if (connectState.value !== 'ready') { notify('文件会话尚未连接'); return }
  if (fileBusy.value) { notify('正在处理上一个操作，请稍候'); return }
  fileBusy.value = true
  try {
    const plan = await api.inspectLocal(paths)
    if (plan.skipped.length && !plan.files.length && !plan.dirs.length) {
      notify('无法读取选中的文件：' + plan.skipped.map(item => item.reason).join('；'))
      return
    }
    if (!plan.files.length && !plan.dirs.length) { notify('没有可上传的文件'); return }
    const existing = await api.statMany(props.sessionId, filePath.value, plan.files.map(item => item.relative))
    if (existing.length) {
      conflict.value = { plan, names: existing.slice(0, 20), count: existing.length }
      return
    }
    await startUpload(plan, false)
  } catch (error) {
    notify(error.message || '上传失败')
  } finally {
    fileBusy.value = false
  }
}

async function resolveConflict(mode) {
  const job = conflict.value
  conflict.value = null
  if (!job || mode === 'cancel') return
  let plan = job.plan
  if (mode === 'skip') {
    const names = new Set(job.names)
    plan = { ...plan, files: plan.files.filter(item => !names.has(item.relative)) }
    if (!plan.files.length && !plan.dirs.length) { notify('已跳过全部同名文件'); return }
  }
  fileBusy.value = true
  try {
    await startUpload(plan, true)
  } catch (error) {
    notify(error.message || '上传失败')
  } finally {
    fileBusy.value = false
  }
}

async function startUpload(plan, overwrite) {
  const transferId = newId()
  upsertTransfer({
    transferId, kind: 'upload', label: '准备上传…', percent: 0, bytesPerSecond: 0, eta: null,
    fileIndex: 0, fileCount: plan.files.length, transferred: 0, total: plan.totalBytes, done: false,
  })
  try {
    await api.upload({
      sessionId: props.sessionId,
      transferId,
      targetDir: filePath.value,
      files: plan.files,
      dirs: plan.dirs,
      overwrite,
    })
    const summary = []
    if (plan.files.length) summary.push(`已上传 ${plan.files.length} 个文件`)
    if (plan.dirs.length) summary.push(`目录 ${plan.dirs.length} 个`)
    notify(summary.join('，') || '已完成')
    await loadFiles(filePath.value)
  } finally {
    removeTransfer(transferId, 1500)
  }
}

function upsertTransfer(payload) {
  const index = transfers.value.findIndex(item => item.transferId === payload.transferId)
  if (index >= 0) transfers.value.splice(index, 1, { ...transfers.value[index], ...payload })
  else transfers.value.push({ ...payload })
}
function removeTransfer(transferId, delay = 0) {
  const clear = () => {
    const index = transfers.value.findIndex(item => item.transferId === transferId)
    if (index >= 0) transfers.value.splice(index, 1)
    const timer = transferTimers.get(transferId)
    if (timer) { clearTimeout(timer); transferTimers.delete(transferId) }
  }
  if (!delay) { clear(); return }
  const existing = transferTimers.get(transferId)
  if (existing) clearTimeout(existing)
  transferTimers.set(transferId, setTimeout(clear, delay))
}
function cancelTransfer(item) {
  api.cancel(item.transferId).catch(() => {})
  notify('正在取消 ' + (item.kind === 'download' ? '下载' : '上传'))
}
function formatSpeed(value) {
  const speed = Number(value) || 0
  if (speed < 1024) return speed + ' B/s'
  if (speed < 1024 * 1024) return (speed / 1024).toFixed(1) + ' KB/s'
  return (speed / 1024 / 1024).toFixed(1) + ' MB/s'
}
function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '—'
  const value = Math.max(0, Math.round(Number(seconds)))
  if (value < 60) return value + ' 秒'
  if (value < 3600) return Math.floor(value / 60) + ' 分 ' + (value % 60) + ' 秒'
  return Math.floor(value / 3600) + ' 小时 ' + Math.floor((value % 3600) / 60) + ' 分'
}

function onFileDragEnter() { if (!fileBusy.value) fileDragActive.value = true }
function onFileDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) fileDragActive.value = false
}
async function onFileDrop(event) {
  fileDragActive.value = false
  const files = [...(event.dataTransfer?.files || [])]
  const paths = files.map(file => {
    try { return window.shellDeck.getPathForFile(file) } catch { return '' }
  }).filter(Boolean)
  if (!paths.length) { notify('无法读取拖入文件的本地路径，请使用上传按钮'); return }
  await uploadPaths(paths)
}

async function editFile(entry) {
  editor.value = { open: true, path: joinPath(entry.name), name: entry.name, content: '', busy: true }
  try {
    editor.value.content = await api.read(props.sessionId, joinPath(entry.name))
  } catch (error) {
    editor.value.open = false
    notify(error.message || '读取失败')
  } finally {
    editor.value.busy = false
  }
}
async function saveEdit() {
  editor.value.busy = true
  try {
    await api.write(props.sessionId, editor.value.path, editor.value.content)
    editor.value.open = false
    notify('文件已保存')
    await loadFiles(filePath.value)
  } catch (error) {
    notify(error.message || '保存失败')
  } finally {
    editor.value.busy = false
  }
}
function askName(title, value, action) { nameDialog.value = { open: true, title, value, action } }
function confirmName() {
  const value = nameDialog.value.value.trim()
  if (!value) return
  const action = nameDialog.value.action
  nameDialog.value.open = false
  action(value)
}
function newFolder() {
  askName('新建文件夹', '', async name => {
    try { await api.mkdir(props.sessionId, joinPath(name)); await loadFiles(filePath.value) }
    catch (error) { notify(error.message || '新建失败') }
  })
}
function renameEntry(entry) {
  askName('重命名', entry.name, async name => {
    try { await api.rename(props.sessionId, joinPath(entry.name), joinPath(name)); await loadFiles(filePath.value) }
    catch (error) { notify(error.message || '重命名失败') }
  })
}
async function confirmDelete() {
  const entry = deleteFile.value
  deleteFile.value = null
  if (!entry) return
  try {
    await api.remove(props.sessionId, joinPath(entry.name), entry.type === 'dir')
    await loadFiles(filePath.value)
  } catch (error) {
    notify(error.message || '删除失败')
  }
}
function openPerm(entry) {
  const dir = !entry || entry.type === 'dir'
  const perm = entry ? entry.perm : filePerm.value
  const current = perm === undefined || perm === null ? '' : Number(perm).toString(8).padStart(3, '0')
  permDialog.value = {
    open: true, path: entry ? joinPath(entry.name) : (filePath.value || '/'),
    name: entry ? entry.name : (filePath.value || '/'), dir, current,
    mode: current || '644', recursive: false, busy: false, error: '',
  }
}
function presetPerm(value) { permDialog.value.mode = value }
async function applyPerm() {
  const dialog = permDialog.value
  if (!/^[0-7]{3}$/.test(dialog.mode)) { dialog.error = '请输入 3 位八进制权限，例如 644'; return }
  dialog.busy = true
  dialog.error = ''
  try {
    const result = await api.chmod(props.sessionId, dialog.path, parseInt(dialog.mode, 8), dialog.dir && dialog.recursive)
    permDialog.value = { ...permDialog.value, open: false }
    notify(result.count > 1 ? `权限已更新，共 ${result.count} 项` : '权限已更新')
    await loadFiles(filePath.value)
  } catch (error) {
    dialog.error = error.message || '修改权限失败'
  } finally {
    dialog.busy = false
  }
}
function formatSize(value) {
  if (value < 1024) return value + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
function formatTime(unix) {
  if (!unix) return '—'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(unix * 1000))
}
function modeText(entry) {
  if (entry.modeText) return entry.modeText
  if (entry.perm !== undefined && entry.perm !== null) return Number(entry.perm).toString(8).padStart(3, '0')
  return '—'
}
function fileIcon(entry) {
  if (entry.type === 'dir') return '▣'
  if (entry.type === 'link') return '↗'
  return '≡'
}

onMounted(() => {
  try { fileSudo.value = localStorage.getItem(localSudoKey()) === '1' } catch { fileSudo.value = false }
  unsubscribers = [
    window.shellDeck.on('transfer:progress', payload => {
      if (payload.sessionId !== props.sessionId) return
      upsertTransfer(payload)
    }),
    window.shellDeck.on('transfer:done', payload => {
      if (payload.sessionId !== props.sessionId) return
      upsertTransfer({ ...payload, done: true })
      removeTransfer(payload.transferId, 2500)
    }),
    window.shellDeck.on('transfer:error', payload => {
      if (payload.sessionId !== props.sessionId) return
      upsertTransfer({ ...payload, done: true, error: payload.message })
      removeTransfer(payload.transferId, 5000)
      notify(payload.message || '传输失败')
    }),
  ]
  connectFiles()
})
onBeforeUnmount(() => {
  unbindFileMenu()
  closeFileMenu()
  for (const off of unsubscribers) { try { off() } catch { /* gone */ } }
  unsubscribers = []
  for (const timer of transferTimers.values()) clearTimeout(timer)
  transferTimers.clear()
  closeFileSession()
})
</script>

<template>
  <div class="ssh-file-session">
    <div class="ssh-filepathbar">
      <div class="ssh-crumbs">
        <button type="button" class="ssh-crumb" @click="loadFiles('/')">根目录</button>
        <template v-for="crumb in fileCrumbs" :key="crumb.path">
          <span class="ssh-crumbsep">/</span>
          <button type="button" class="ssh-crumb" @click="loadFiles(crumb.path)">{{ crumb.name }}</button>
        </template>
        <span v-if="fileSudo" class="ssh-rootbadge">root</span>
      </div>
      <div class="ssh-pathrow">
        <input v-model="filePathInput" class="ssh-pathinput" placeholder="输入路径后回车，例如 /etc/nginx" @keydown.enter="goPath" />
        <button type="button" class="ssh-secondary" :disabled="fileBusy || connectState !== 'ready'" @click="goPath">前往</button>
        <label class="ssh-sudo" title="用该账号的 sudo 权限打开文件管理，需要账号有 sudo 权限"><input type="checkbox" :checked="fileSudo" @change="toggleSudo" /><span>root 模式</span></label>
      </div>
    </div>
    <div class="ssh-filebar">
      <button type="button" class="ssh-secondary" :disabled="!fileParent || fileBusy" @click="loadFiles(fileParent)">↑ 上一级</button>
      <button type="button" class="ssh-secondary" :disabled="fileBusy || connectState !== 'ready'" @click="loadFiles(filePath)">刷新</button>
      <button type="button" class="ssh-primary" :disabled="fileBusy || connectState !== 'ready'" @click="pickUpload">上传</button>
      <button type="button" class="ssh-secondary" :disabled="fileBusy || connectState !== 'ready'" @click="pickFolder">上传文件夹</button>
      <button type="button" class="ssh-secondary" :disabled="fileBusy || connectState !== 'ready'" @click="newFolder">新建文件夹</button>
      <button type="button" class="ssh-secondary" :disabled="!filePath || fileBusy || connectState !== 'ready'" @click="openPerm(null)">本目录权限</button>
      <span class="ssh-draghint">可拖文件进列表上传</span>
    </div>
    <div v-if="activeTransfers.length" class="ssh-transfers">
      <div v-for="item in activeTransfers" :key="item.transferId" class="ssh-transfer">
        <div class="ssh-transfer-head">
          <span>{{ item.kind === 'download' ? '下载' : '上传' }} · {{ item.label }}</span>
          <b>{{ item.percent || 0 }}%</b>
        </div>
        <div class="ssh-uploadbar"><i :style="{ width: (item.percent || 0) + '%' }"></i></div>
        <div class="ssh-transfer-meta">
          <span>{{ formatSpeed(item.bytesPerSecond) }}</span>
          <span>剩余 {{ formatEta(item.eta) }}</span>
          <span v-if="item.fileTotal">文件 {{ item.fileIndex }}/{{ item.fileCount }} · {{ formatSize(item.fileTransferred || 0) }}/{{ formatSize(item.fileTotal) }}</span>
          <button type="button" @click="cancelTransfer(item)">取消</button>
        </div>
      </div>
    </div>
    <p v-if="fileError" class="ssh-error">{{ fileError }} <button v-if="connectState === 'error'" type="button" class="ssh-link" @click="connectFiles">重新连接</button></p>
    <div class="ssh-filetablewrap" @dragenter.prevent="onFileDragEnter" @dragover.prevent="onFileDragEnter" @dragleave.prevent="onFileDragLeave" @drop.prevent="onFileDrop" @contextmenu.prevent="openFileMenu($event, null)">
      <table class="ssh-filetable">
        <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>权限</th><th></th></tr></thead>
        <tbody>
          <tr v-if="connectState !== 'ready'">
            <td colspan="5" class="ssh-fileempty">{{ connectState === 'connecting' ? '正在连接…' : '文件会话未连接' }}</td>
          </tr>
          <tr v-else-if="fileBusy && !sortedEntries.length"><td colspan="5" class="ssh-fileempty">正在读取…</td></tr>
          <tr v-else-if="!sortedEntries.length"><td colspan="5" class="ssh-fileempty">目录为空</td></tr>
          <tr v-for="entry in sortedEntries" :key="entry.name" @contextmenu.prevent.stop="openFileMenu($event, entry)">
            <td><button type="button" class="ssh-filebtn" @click="enterEntry(entry)"><span>{{ fileIcon(entry) }}</span>{{ entry.name }}</button></td>
            <td>{{ entry.type === 'dir' ? '—' : formatSize(entry.size) }}</td>
            <td>{{ formatTime(entry.mtime) }}</td>
            <td class="ssh-filemode" :title="entry.modeText || ''">{{ modeText(entry) }}</td>
            <td class="ssh-fileactions">
              <button v-if="entry.type !== 'dir'" type="button" class="ssh-link" @click="downloadFile(entry)">下载</button>
              <button v-if="entry.type === 'file'" type="button" class="ssh-link" @click="editFile(entry)">编辑</button>
              <button type="button" class="ssh-link" @click="openPerm(entry)">权限</button>
              <button type="button" class="ssh-link" @click="renameEntry(entry)">重命名</button>
              <button type="button" class="ssh-link danger" @click="deleteFile = entry">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="fileDragActive" class="ssh-droplayer">松开鼠标，上传到 {{ filePath || '/' }}</div>
      <div v-if="conflict" class="ssh-file-conflict">
        <div class="ssh-file-conflictbox">
          <b>同名文件已存在</b>
          <p>目标目录里已有 <code v-for="name in conflict.names" :key="name">{{ name }}</code>{{ conflict.count > conflict.names.length ? ` 等 ${conflict.count} 项` : '' }}。继续上传会覆盖原内容。</p>
          <div class="ssh-file-conflictactions">
            <button type="button" @click="resolveConflict('skip')">跳过已存在</button>
            <button type="button" class="primary" @click="resolveConflict('overwrite')">覆盖</button>
            <button type="button" @click="resolveConflict('cancel')">取消</button>
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="fileMenu" class="context-menu" :style="{ left: fileMenu.x + 'px', top: fileMenu.y + 'px' }" role="menu">
        <div class="context-menu-head">{{ fileMenu.entry ? fileMenu.entry.name : (filePath || '/') }}</div>
        <template v-if="fileMenu.entry">
          <button v-if="fileMenu.entry.type === 'dir'" type="button" @click="enterEntry(fileMenu.entry); closeFileMenu()">打开</button>
          <button v-else-if="fileMenu.entry.type === 'file'" type="button" @click="editFile(fileMenu.entry); closeFileMenu()">编辑</button>
          <button v-if="fileMenu.entry.type !== 'dir'" type="button" @click="downloadFile(fileMenu.entry); closeFileMenu()">下载</button>
          <div class="context-menu-sep"></div>
          <button type="button" :disabled="fileBusy" @click="copyEntry(fileMenu.entry, 'copy')">复制</button>
          <button type="button" :disabled="fileBusy" @click="copyEntry(fileMenu.entry, 'cut')">剪切</button>
          <button type="button" :disabled="!clipboard || fileBusy" @click="pasteClipboard">粘贴</button>
          <button type="button" @click="copyEntryPath(fileMenu.entry)">复制路径</button>
          <div class="context-menu-sep"></div>
          <button type="button" :disabled="fileBusy" @click="moveEntry(fileMenu.entry)">移动到…</button>
          <button type="button" :disabled="fileBusy" @click="renameEntry(fileMenu.entry); closeFileMenu()">重命名</button>
          <button type="button" :disabled="fileBusy" @click="openPerm(fileMenu.entry); closeFileMenu()">权限</button>
          <button type="button" class="danger" :disabled="fileBusy" @click="deleteFile = fileMenu.entry; closeFileMenu()">删除</button>
          <div class="context-menu-sep"></div>
          <button type="button" @click="refreshFiles">刷新</button>
        </template>
        <template v-else>
          <button type="button" :disabled="!clipboard || fileBusy" @click="pasteClipboard">粘贴</button>
          <div class="context-menu-sep"></div>
          <button type="button" :disabled="fileBusy" @click="newFolder(); closeFileMenu()">新建文件夹</button>
          <button type="button" :disabled="fileBusy" @click="pickUpload(); closeFileMenu()">上传文件</button>
          <button type="button" :disabled="fileBusy" @click="pickFolder(); closeFileMenu()">上传文件夹</button>
          <div class="context-menu-sep"></div>
          <button type="button" @click="refreshFiles">刷新</button>
        </template>
      </div>

      <div v-if="overwriteDialog" class="um-overlay">
        <section class="um-dialog ssh-confirm-dialog" role="dialog" aria-modal="true">
          <button class="um-close" aria-label="关闭" @click="overwriteDialog = null">×</button>
          <h2>目标已存在</h2>
          <p>当前目录已有同名文件或文件夹，{{ overwriteDialog.label }}会覆盖原内容。确定继续？</p>
          <div class="um-dialog-actions">
            <button type="button" @click="overwriteDialog = null">取消</button>
            <button type="button" class="um-danger-button" @click="confirmOverwrite">覆盖</button>
          </div>
        </section>
      </div>

      <div v-if="permDialog.open" class="um-overlay">
        <section class="um-dialog ssh-perm-dialog" role="dialog" aria-modal="true">
          <button class="um-close" aria-label="关闭" @click="permDialog.open = false">×</button>
          <h2>权限 · {{ permDialog.name }}</h2>
          <p class="ssh-filedir">{{ permDialog.path }}<span v-if="permDialog.current"> · 当前 {{ permDialog.current }}</span></p>
          <div class="ssh-permpresets">
            <button v-for="value in ['644', '755', '600', '700']" :key="value" type="button" class="pv-pick" :class="{ active: permDialog.mode === value }" @click="presetPerm(value)">{{ value }}</button>
          </div>
          <label class="ssh-perminput">权限值（八进制）<input v-model="permDialog.mode" maxlength="3" inputmode="numeric" placeholder="644" @keydown.enter.prevent="applyPerm" /></label>
          <label v-if="permDialog.dir" class="ssh-permscope"><input v-model="permDialog.recursive" type="checkbox" />同时应用到所有子文件和子目录</label>
          <p class="ssh-permhint">目录会自动保留可进入的执行权限；子项很多时可能需要稍等。</p>
          <p v-if="permDialog.error" class="ssh-error">{{ permDialog.error }}</p>
          <div class="um-dialog-actions">
            <button type="button" @click="permDialog.open = false">取消</button>
            <button type="button" class="um-primary" :disabled="permDialog.busy" @click="applyPerm">{{ permDialog.busy ? '应用中…' : '应用' }}</button>
          </div>
        </section>
      </div>

      <div v-if="editor.open" class="um-overlay">
        <section class="um-dialog ssh-editor-dialog" role="dialog" aria-modal="true">
          <button class="um-close" aria-label="关闭" @click="editor.open = false">×</button>
          <h2>编辑 · {{ editor.name }}</h2>
          <p class="ssh-filedir">{{ editor.path }}</p>
          <textarea v-model="editor.content" class="ssh-editor" spellcheck="false"></textarea>
          <div class="um-dialog-actions">
            <button type="button" @click="editor.open = false">取消</button>
            <button type="button" class="um-primary" :disabled="editor.busy" @click="saveEdit">{{ editor.busy ? '保存中…' : '保存' }}</button>
          </div>
        </section>
      </div>

      <div v-if="nameDialog.open" class="um-overlay">
        <section class="um-dialog ssh-name-dialog" role="dialog" aria-modal="true">
          <h2>{{ nameDialog.title }}</h2>
          <input v-model="nameDialog.value" class="ssh-nameinput" maxlength="255" @keydown.enter="confirmName" />
          <div class="um-dialog-actions">
            <button type="button" @click="nameDialog.open = false">取消</button>
            <button type="button" class="um-primary" @click="confirmName">确定</button>
          </div>
        </section>
      </div>

      <div v-if="deleteFile" class="um-overlay">
        <section class="um-dialog ssh-name-dialog" role="dialog" aria-modal="true">
          <h2>删除 {{ deleteFile.type === 'dir' ? '文件夹' : '文件' }}</h2>
          <p class="ssh-deletemsg">{{ deleteFile.name }}<span v-if="deleteFile.type === 'dir'">，文件夹内的全部内容也会删除。</span></p>
          <div class="um-dialog-actions">
            <button type="button" @click="deleteFile = null">取消</button>
            <button type="button" class="um-danger-button" @click="confirmDelete">删除</button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
