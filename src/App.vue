<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as XLSX from 'xlsx'
import SshWorkspace from './SshWorkspace.vue'
import ServerEditor from './ServerEditor.vue'
import CommandsDialog from './CommandsDialog.vue'
import SettingsDialog from './SettingsDialog.vue'
import UpdateDialog from './UpdateDialog.vue'

const servers = ref([])
const commands = ref([])
const loading = ref(true)
const appVersion = ref('')
const theme = ref('light')
const knownTags = computed(() => {
  const counts = new Map()
  for (const server of servers.value) {
    for (const tag of server.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([tag]) => tag)
})

const toast = ref({ visible: false, message: '', kind: 'info' })
let toastTimer = 0
let unsubscribers = []

const editor = ref({ open: false, server: null, busy: false, error: '' })
const commandsOpen = ref(false)
const commandBusy = ref(false)
const commandError = ref('')

const settingsOpen = ref(false)
const dataBusy = ref(false)
const info = ref({})
const dataError = ref('')
const networkMode = ref('accelerator')
const proxy = ref('')
const acceleratorMode = ref('auto')
const acceleratorCustom = ref('')
const autoCheck = ref(true)
const updateState = ref({ status: 'idle' })
const updateError = ref('')
const updateBusy = ref(false)
const updateOpen = ref(false)
const updateConfirmOpen = ref(false)

function showToast(message, kind = 'info') {
  if (!message) return
  clearTimeout(toastTimer)
  toast.value = { visible: true, message: String(message), kind }
  toastTimer = setTimeout(() => { toast.value = { ...toast.value, visible: false } }, kind === 'error' ? 6000 : 3200)
}

async function loadServers() {
  servers.value = await window.shellDeck.servers.list()
}
async function loadCommands() {
  commands.value = await window.shellDeck.commands.list()
}

onMounted(async () => {
  unsubscribers = [
    window.shellDeck.on('app:toast', payload => showToast(payload.message, payload.kind)),
    window.shellDeck.on('updater:state', state => {
      updateState.value = state
      if (state.status === 'error') updateError.value = state.error || ''
    }),
  ]
  try {
    const [appInfo, savedTheme, savedNet, savedProxy, savedAccel, savedAccelCustom, savedAuto, initialState] = await Promise.all([
      window.shellDeck.app.info(),
      window.shellDeck.settings.get('ui.theme'),
      window.shellDeck.settings.get('update.networkMode'),
      window.shellDeck.settings.get('update.proxy'),
      window.shellDeck.settings.get('update.accelerator'),
      window.shellDeck.settings.get('update.acceleratorCustom'),
      window.shellDeck.settings.get('update.autoCheck'),
      window.shellDeck.updater.state(),
      loadServers(),
      loadCommands(),
    ])
    info.value = appInfo
    appVersion.value = appInfo.version || ''
    networkMode.value = savedNet || 'accelerator'
    proxy.value = savedProxy || ''
    acceleratorMode.value = savedAccel || 'auto'
    acceleratorCustom.value = savedAccelCustom || ''
    autoCheck.value = savedAuto !== '0'
    updateState.value = initialState || { status: 'idle' }
    applyTheme(savedTheme === 'dark' ? 'dark' : 'light')
  } catch (error) {
    showToast(error.message || '读取本地数据失败', 'error')
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => {
  clearTimeout(toastTimer)
  for (const off of unsubscribers) { try { off() } catch { /* gone */ } }
})

function applyTheme(value) {
  theme.value = value
  document.documentElement.classList.toggle('theme-dark', value === 'dark')
}
async function toggleTheme() {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try { await window.shellDeck.settings.set('ui.theme', next) }
  catch { /* Theme still applies for this session. */ }
}
function openNewServer() {
  editor.value = { open: true, server: null, busy: false, error: '' }
}
function openEditServer(server) {
  editor.value = { open: true, server: { ...server, tags: [...(server.tags || [])] }, busy: false, error: '' }
}
function closeEditor() {
  editor.value = { ...editor.value, open: false }
}
async function saveServer(payload) {
  editor.value = { ...editor.value, busy: true, error: '' }
  try {
    await window.shellDeck.servers.save(payload)
    await loadServers()
    editor.value = { ...editor.value, open: false, busy: false }
    showToast('服务器已保存')
  } catch (error) {
    editor.value = { ...editor.value, busy: false, error: error.message || '保存失败' }
  }
}
async function deleteServer(server) {
  try {
    await window.shellDeck.servers.remove(server.id)
    await loadServers()
    showToast(`已删除服务器 ${server.name}`)
  } catch (error) {
    showToast(error.message || '删除失败', 'error')
  }
}

async function importExcel() {
  try {
    const file = await window.shellDeck.dialog.openExcel()
    if (!file) return
    const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0))
    const workbook = XLSX.read(bytes, { type: 'array' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) { showToast('Excel 中没有工作表', 'error'); return }
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    if (!rows.length) { showToast('Excel 中没有服务器数据', 'error'); return }
    const result = await window.shellDeck.servers.importMany(rows)
    await loadServers()
    showToast(`导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`)
  } catch (error) {
    showToast(error.message || '导入失败', 'error')
  }
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

async function exportExcel(list) {
  try {
    const rows = (list || []).map(server => ({
      ID: server.id,
      名称: server.name,
      主机: server.host,
      端口: server.port,
      账号: server.username,
      密码: server.password,
      认证方式: server.authType === 'key' ? '密钥' : '密码',
      私钥: server.privateKey || '',
      口令: server.passphrase || '',
      备注: server.note || '',
      标签: (server.tags || []).join(','),
    }))
    if (!rows.length) { showToast('当前筛选结果为空，未导出', 'error'); return }
    const sheet = XLSX.utils.json_to_sheet(rows)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, '服务器')
    const output = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const saved = await window.shellDeck.dialog.saveExcel({
      name: `ShellDeck-servers-${stamp}.xlsx`,
      data: bytesToBase64(new Uint8Array(output)),
    })
    if (saved) showToast('已导出到 ' + saved + '（包含明文凭据，请妥善保管）')
  } catch (error) {
    showToast(error.message || '导出失败', 'error')
  }
}

function openCommands() {
  commandError.value = ''
  commandsOpen.value = true
}
async function saveCommand(payload) {
  commandBusy.value = true
  commandError.value = ''
  try {
    await window.shellDeck.commands.save(payload)
    await loadCommands()
    showToast('常用指令已保存')
  } catch (error) {
    commandError.value = error.message || '保存失败'
  } finally {
    commandBusy.value = false
  }
}
async function removeCommand(id) {
  commandBusy.value = true
  commandError.value = ''
  try {
    await window.shellDeck.commands.remove(id)
    await loadCommands()
    showToast('指令已删除')
  } catch (error) {
    commandError.value = error.message || '删除失败'
  } finally {
    commandBusy.value = false
  }
}

async function openSettings() {
  settingsOpen.value = true
  dataError.value = ''
  updateError.value = ''
  try {
    const [appInfo, net, proxyValue, accel, accelCustom, auto, state] = await Promise.all([
      window.shellDeck.app.info(),
      window.shellDeck.settings.get('update.networkMode'),
      window.shellDeck.settings.get('update.proxy'),
      window.shellDeck.settings.get('update.accelerator'),
      window.shellDeck.settings.get('update.acceleratorCustom'),
      window.shellDeck.settings.get('update.autoCheck'),
      window.shellDeck.updater.state(),
    ])
    info.value = appInfo
    networkMode.value = net || 'accelerator'
    proxy.value = proxyValue || ''
    acceleratorMode.value = accel || 'auto'
    acceleratorCustom.value = accelCustom || ''
    autoCheck.value = auto !== '0'
    updateState.value = state
  } catch (error) {
    showToast(error.message || '读取设置失败', 'error')
  }
}
async function saveNetwork({ networkMode: mode, proxy: proxyValue, acceleratorMode: accel, acceleratorCustom: custom }) {
  updateBusy.value = true
  updateError.value = ''
  try {
    await Promise.all([
      window.shellDeck.settings.set('update.networkMode', mode),
      window.shellDeck.settings.set('update.proxy', proxyValue || ''),
      window.shellDeck.settings.set('update.accelerator', accel),
      window.shellDeck.settings.set('update.acceleratorCustom', custom || ''),
    ])
    networkMode.value = mode
    proxy.value = proxyValue || ''
    acceleratorMode.value = accel
    acceleratorCustom.value = custom || ''
    showToast('更新网络设置已保存')
  } catch (error) {
    updateError.value = error.message || '保存更新网络设置失败'
  } finally {
    updateBusy.value = false
  }
}
async function toggleAutoCheck(value) {
  autoCheck.value = value
  try { await window.shellDeck.settings.set('update.autoCheck', value ? '1' : '0') }
  catch (error) { showToast(error.message || '保存设置失败', 'error') }
}
async function checkUpdate() {
  updateBusy.value = true
  updateError.value = ''
  try {
    updateState.value = await window.shellDeck.updater.check()
  } catch (error) {
    updateError.value = error.message || '检查更新失败'
  } finally {
    updateBusy.value = false
  }
}
async function updateNow() {
  updateBusy.value = true
  updateError.value = ''
  try {
    let state = updateState.value
    if (!state.asset || ['idle', 'error', 'up-to-date'].includes(state.status)) {
      state = await window.shellDeck.updater.check()
      updateState.value = state
    }
    if (state.status === 'available') {
      state = await window.shellDeck.updater.download()
      updateState.value = state
    }
    if (state.status === 'ready' && info.value.packaged && state.asset?.format !== 'full') {
      updateConfirmOpen.value = true
    }
  } catch (error) {
    updateError.value = error.message || '更新失败'
  } finally {
    updateBusy.value = false
  }
}
async function installUpdate() {
  updateConfirmOpen.value = false
  updateBusy.value = true
  updateError.value = ''
  try {
    await window.shellDeck.updater.install()
  } catch (error) {
    updateError.value = error.message || '安装更新失败'
    updateBusy.value = false
    updateOpen.value = true
  }
}
function closeUpdateDialog() {
  updateOpen.value = false
  updateConfirmOpen.value = false
}
function openUpdateDialog() {
  updateOpen.value = true
  updateConfirmOpen.value = false
  updateError.value = ''
  if (updateState.value.status === 'idle') checkUpdate()
}
async function openDataDir() {
  try { await window.shellDeck.app.openDataDir() }
  catch (error) { dataError.value = error.message || '无法打开数据目录' }
}
async function backupDatabase() {
  dataBusy.value = true
  dataError.value = ''
  try {
    const file = await window.shellDeck.app.backupDb()
    showToast('数据库已备份到 ' + file)
  } catch (error) {
    dataError.value = error.message || '备份失败'
  } finally {
    dataBusy.value = false
  }
}
async function restoreDatabase() {
  dataBusy.value = true
  dataError.value = ''
  try {
    const result = await window.shellDeck.app.restoreDb()
    if (!result) return
    await Promise.all([loadServers(), loadCommands()])
    showToast('数据库已恢复，旧数据保存在 ' + result.previousSavedTo)
  } catch (error) {
    dataError.value = error.message || '恢复失败'
  } finally {
    dataBusy.value = false
  }
}
</script>

<template>
  <div class="app-root">
    <div v-if="loading" class="app-loading"><span class="brand-mark">S</span>正在读取本地数据…</div>
    <SshWorkspace
      v-else
      :servers="servers"
      :commands="commands"
      :version="appVersion"
      :theme="theme"
      :update-state="updateState"
      @toggle-theme="toggleTheme"
      @open-update="openUpdateDialog"
      @notice="showToast"
      @new-server="openNewServer"
      @edit-server="openEditServer"
      @delete-server="deleteServer"
      @open-commands="openCommands"
      @open-settings="openSettings"
      @import-excel="importExcel"
      @export-excel="exportExcel"
    />

    <ServerEditor :open="editor.open" :server="editor.server" :known-tags="knownTags" :busy="editor.busy" :error="editor.error" @close="closeEditor" @save="saveServer" />
    <CommandsDialog :open="commandsOpen" :commands="commands" :busy="commandBusy" :error="commandError" @close="commandsOpen = false" @save="saveCommand" @remove="removeCommand" />
    <SettingsDialog
      :open="settingsOpen"
      :info="info"
      :data-error="dataError"
      :data-busy="dataBusy"
      :network-mode="networkMode"
      :proxy="proxy"
      :accelerator-mode="acceleratorMode"
      :accelerator-custom="acceleratorCustom"
      :auto-check="autoCheck"
      :update-state="updateState"
      :update-error="updateError"
      :busy="updateBusy"
      @close="settingsOpen = false"
      @backup="backupDatabase"
      @restore="restoreDatabase"
      @open-data="openDataDir"
      @save-network="saveNetwork"
      @toggle-auto="toggleAutoCheck"
      @check="checkUpdate"
      @open-update="openUpdateDialog"
    />
    <UpdateDialog
      :open="updateOpen"
      :current-version="appVersion"
      :state="updateState"
      :error="updateError"
      :busy="updateBusy"
      :packaged="Boolean(info.packaged)"
      :confirm-open="updateConfirmOpen"
      @close="closeUpdateDialog"
      @update-now="updateNow"
      @confirm-close="updateConfirmOpen = false"
      @confirm-install="installUpdate"
    />

    <div v-if="toast.visible" class="app-toast" :class="toast.kind">{{ toast.message }}</div>
  </div>
</template>
