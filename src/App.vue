<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as XLSX from 'xlsx'
import SshWorkspace from './SshWorkspace.vue'
import ServerEditor from './ServerEditor.vue'
import CommandsDialog from './CommandsDialog.vue'
import SettingsDialog from './SettingsDialog.vue'

const servers = ref([])
const commands = ref([])
const loading = ref(true)
const appVersion = ref('')
const theme = ref('light')
const knownTags = computed(() => {
  const tags = new Set()
  for (const server of servers.value) for (const tag of server.tags || []) tags.add(tag)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'))
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
  ]
  try {
    const [info, savedTheme] = await Promise.all([
      window.shellDeck.app.info(),
      window.shellDeck.settings.get('ui.theme'),
      loadServers(),
      loadCommands(),
    ])
    appVersion.value = info.version || ''
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
  try {
    info.value = await window.shellDeck.app.info()
  } catch (error) {
    showToast(error.message || '读取设置失败', 'error')
  }
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
      @toggle-theme="toggleTheme"
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
      @close="settingsOpen = false"
      @backup="backupDatabase"
      @restore="restoreDatabase"
      @open-data="openDataDir"
    />

    <div v-if="toast.visible" class="app-toast" :class="toast.kind">{{ toast.message }}</div>
  </div>
</template>
