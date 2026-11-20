<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import SshTerminal from './SshTerminal.vue'
import SshFileSession from './SshFileSession.vue'

const props = defineProps({
  servers: { type: Array, default: () => [] },
  commands: { type: Array, default: () => [] },
  version: { type: String, default: '' },
  theme: { type: String, default: 'light' },
  updateState: { type: Object, default: () => ({ status: 'idle' }) },
})
const emit = defineEmits(['notice', 'edit-server', 'copy-server', 'new-server', 'delete-server', 'open-commands', 'open-settings', 'import-excel', 'export-excel', 'toggle-theme', 'open-update'])

const query = ref('')
const tagFilter = ref('')
const tagMoreOpen = ref(false)
const tagSearch = ref('')
const selectedId = ref('')
const sessions = ref([])
const currentPage = ref(0)
const layout = ref(4)
const maxedId = ref('')
const draggingId = ref('')
const dragTarget = ref(-1)
const confirmSession = ref(null)
const bothOpenTarget = ref(null)
const sessionsOpen = ref(false)
const deleteTarget = ref(null)
const newSessionTarget = ref(null)
const serverMenu = ref(null)
const detailTarget = ref(null)
const manualScale = ref(null)

const capacityMap = { 1: 1, 2: 2, 4: 4, 6: 6, 9: 9 }
const autoScales = { 1: 1, 2: 1, 4: 0.95, 6: 0.9, 9: 0.85 }
const capacity = computed(() => capacityMap[layout.value] || 4)
const railTags = computed(() => {
  const top = allTags.value.slice(0, 6)
  if (tagFilter.value && !top.some(tag => tag.name === tagFilter.value)) {
    const active = allTags.value.find(tag => tag.name === tagFilter.value)
    if (active) return [...top, active]
  }
  return top
})
const moreTags = computed(() => {
  const shown = new Set(railTags.value.map(tag => tag.name))
  return allTags.value.filter(tag => !shown.has(tag.name))
})
const searchedMoreTags = computed(() => {
  const text = tagSearch.value.trim().toLowerCase()
  return moreTags.value.filter(tag => !text || tag.name.toLowerCase().includes(text))
})
const allTags = computed(() => {
  const map = new Map()
  props.servers.forEach(server => (server.tags || []).forEach(tag => {
    const key = tag.toLowerCase()
    const seen = map.get(key)
    if (seen) seen.count += 1
    else map.set(key, { name: tag, count: 1 })
  }))
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
})
function ipv4Value(host) {
  const parts = String(host || '').trim().split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const number = Number(part)
    if (number > 255) return null
    value = (value << 8n) | BigInt(number)
  }
  return value
}
function ipv6Value(host) {
  let text = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!text.includes(':')) return null
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  const halves = text.split('::')
  if (halves.length > 2) return null
  let groups = halves[0] ? halves[0].split(':') : []
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : []
    const missing = 8 - groups.length - tail.length
    if (missing < 0) return null
    groups = [...groups, ...Array(missing).fill('0'), ...tail]
  }
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) | BigInt(parseInt(group, 16))
  }
  return value
}
function compareServers(a, b) {
  const hostA = String(a.host || '').trim()
  const hostB = String(b.host || '').trim()
  const a4 = ipv4Value(hostA)
  const b4 = ipv4Value(hostB)
  const a6 = a4 === null ? ipv6Value(hostA) : null
  const b6 = b4 === null ? ipv6Value(hostB) : null
  const rankA = a4 !== null ? 0 : a6 !== null ? 1 : 2
  const rankB = b4 !== null ? 0 : b6 !== null ? 1 : 2
  if (rankA !== rankB) return rankA - rankB
  if (rankA === 0 && a4 !== b4) return a4 < b4 ? -1 : 1
  if (rankA === 1 && a6 !== b6) return a6 < b6 ? -1 : 1
  const hostCompare = hostA.localeCompare(hostB, 'zh-CN', { numeric: true, sensitivity: 'base' })
  if (hostCompare) return hostCompare
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}
const filteredServers = computed(() => {
  const text = query.value.trim().toLowerCase()
  return props.servers.filter(server => {
    if (tagFilter.value && !(server.tags || []).some(tag => tag.toLowerCase() === tagFilter.value.toLowerCase())) return false
    if (!text) return true
    return [server.name, server.host, server.username, server.note, `${server.host}:${server.port}`, ...(server.tags || [])].join(' ').toLowerCase().includes(text)
  }).sort(compareServers)
})
const selectedServer = computed(() => props.servers.find(server => server.id === selectedId.value) || null)
const pageCount = computed(() => Math.max(1, Math.ceil(sessions.value.length / capacity.value)))
const pageSessions = computed(() => sessions.value.slice(currentPage.value * capacity.value, (currentPage.value + 1) * capacity.value))
const emptySlots = computed(() => Math.max(0, capacity.value - pageSessions.value.length))
const scale = computed(() => manualScale.value ?? autoScales[layout.value] ?? 1)
const allSessions = computed(() => sessions.value.map((session, index) => ({ session, index, page: Math.floor(index / capacity.value) })))

watch(() => props.servers, list => {
  if (!list.length) { selectedId.value = ''; return }
  if (!list.some(server => server.id === selectedId.value)) selectedId.value = [...list].sort(compareServers)[0].id
}, { immediate: true })
watch(() => sessions.value.length, () => {
  if (currentPage.value >= pageCount.value) currentPage.value = pageCount.value - 1
})
watch(pageCount, value => {
  if (currentPage.value > value - 1) currentPage.value = value - 1
  if (currentPage.value < 0) currentPage.value = 0
})
watch(currentPage, value => {
  if (value < 0) currentPage.value = 0
  if (value >= pageCount.value) currentPage.value = pageCount.value - 1
})

function showNotice(text) { emit('notice', text) }
function selectTag(tag) {
  tagFilter.value = tag
  tagMoreOpen.value = false
  tagSearch.value = ''
}
function toggleTagMore() {
  tagMoreOpen.value = !tagMoreOpen.value
  if (!tagMoreOpen.value) tagSearch.value = ''
}
function selectServer(server) {
  if (!server) return
  selectedId.value = server.id
}
async function copyPassword(server = selectedServer.value) {
  const password = server?.password
  if (!password) { showNotice('未保存密码'); return }
  try {
    await window.shellDeck.clipboard.write(password)
    showNotice('密码已复制')
  } catch {
    showNotice('复制失败')
  }
}
function serverFor(session) { return props.servers.find(server => server.id === session.serverId) || session.server }
function sessionTitle(session) { return `${session.kind === 'file' ? 'XFTP' : 'SSH'} · ${serverFor(session)?.name || session.server.name}` }
function sessionMeta(session) {
  const server = serverFor(session)
  return server ? `${server.username}@${server.host}:${server.port}` : ''
}
function isSessionVisible(index) {
  return Math.floor(index / capacity.value) === currentPage.value
}
function setLayout(value) {
  layout.value = Number(value)
  maxedId.value = ''
}
function changeLayout(event) { setLayout(event.target.value) }
function changeScale(event) { manualScale.value = event.target.value === 'auto' ? null : Number(event.target.value) }
function setPage(index) {
  currentPage.value = Math.max(0, Math.min(index, pageCount.value - 1))
}
function handleServerDblClick(server) {
  if (!server) return
  selectedId.value = server.id
  const kinds = new Set(sessions.value.filter(session => session.serverId === server.id).map(session => session.kind))
  if (!kinds.has('terminal')) { openNow('terminal', server); return }
  if (!kinds.has('file')) { openNow('file', server); return }
  bothOpenTarget.value = server
}
function requestOpen(kind, server = selectedServer.value) {
  if (!server) { showNotice('请先选择左侧服务器'); return }
  if (sessions.value.some(session => session.serverId === server.id && session.kind === kind)) {
    confirmSession.value = { kind, server }
    return
  }
  openNow(kind, server)
}
function openNow(kind, server) {
  const size = capacity.value
  let targetPage = currentPage.value
  let targetCount = sessions.value.slice(targetPage * size, (targetPage + 1) * size).length
  if (targetCount >= size) {
    targetPage = -1
    for (let page = 0; page < pageCount.value; page += 1) {
      if (sessions.value.slice(page * size, (page + 1) * size).length < size) { targetPage = page; break }
    }
    if (targetPage < 0) targetPage = pageCount.value
    targetCount = sessions.value.slice(targetPage * size, (targetPage + 1) * size).length
  }
  currentPage.value = targetPage
  const session = {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    serverId: server.id,
    server: { ...server, tags: [...(server.tags || [])] },
  }
  sessions.value.splice(targetPage * size + targetCount, 0, session)
  selectedId.value = server.id
  confirmSession.value = null
  maxedId.value = ''
}
function confirmOpen() {
  const pending = confirmSession.value
  if (!pending) return
  openNow(pending.kind, pending.server)
}
function closeSession(session) {
  const index = sessions.value.findIndex(item => item.id === session.id)
  if (index < 0) return
  sessions.value.splice(index, 1)
  if (maxedId.value === session.id) maxedId.value = ''
  if (!sessions.value.length) currentPage.value = 0
  else if (currentPage.value >= pageCount.value) currentPage.value = pageCount.value - 1
}
function toggleMax(session) {
  maxedId.value = maxedId.value === session.id ? '' : session.id
}
function dragStart(session, event) {
  if (maxedId.value) { event.preventDefault(); return }
  draggingId.value = session.id
  dragTarget.value = -1
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', session.id)
}
function dragEnd() {
  draggingId.value = ''
  dragTarget.value = -1
}
function sessionForSlot(index) {
  return sessions.value[currentPage.value * capacity.value + index] || null
}
function dropSlot(index) {
  const sourceId = draggingId.value
  dragTarget.value = -1
  draggingId.value = ''
  if (!sourceId) return
  const sourceIndex = sessions.value.findIndex(item => item.id === sourceId)
  if (sourceIndex < 0) return
  const [source] = sessions.value.splice(sourceIndex, 1)
  const targetIndex = Math.min(currentPage.value * capacity.value + index, sessions.value.length)
  sessions.value.splice(targetIndex, 0, source)
}
function dropSession(target) {
  const sourceId = draggingId.value
  dragTarget.value = -1
  draggingId.value = ''
  if (!sourceId || sourceId === target.id) return
  const sourceIndex = sessions.value.findIndex(item => item.id === sourceId)
  const targetIndex = sessions.value.findIndex(item => item.id === target.id)
  if (sourceIndex < 0 || targetIndex < 0) return
  if (Math.floor(sourceIndex / capacity.value) !== Math.floor(targetIndex / capacity.value)) return
  const [source] = sessions.value.splice(sourceIndex, 1)
  sessions.value.splice(targetIndex, 0, source)
}
function openSessions() { sessionsOpen.value = true }
function jumpToSession(row) {
  currentPage.value = row.page
  selectedId.value = row.session.serverId
  sessionsOpen.value = false
}
function newServer() { emit('new-server') }
function openSessionPicker(server) {
  if (!server) return
  selectedId.value = server.id
  newSessionTarget.value = server
}
function openServerMenu(server, event) {
  if (!server) return
  selectedId.value = server.id
  const width = 190
  const height = 370
  serverMenu.value = {
    server,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  }
}
function closeServerMenu() { serverMenu.value = null }
function menuTargetInside(event) {
  return event.target instanceof Element && Boolean(event.target.closest('.server-menu'))
}
function closeOnOutside(event) {
  if (!serverMenu.value || menuTargetInside(event)) return
  closeServerMenu()
}
function closeOnEscape(event) {
  if (event.key === 'Escape') closeServerMenu()
}
function unbindMenuListeners() {
  window.removeEventListener('mousedown', closeOnOutside, true)
  window.removeEventListener('contextmenu', closeOnOutside, true)
  window.removeEventListener('keydown', closeOnEscape)
  window.removeEventListener('blur', closeServerMenu)
  window.removeEventListener('resize', closeServerMenu)
  window.removeEventListener('wheel', closeServerMenu, true)
}
watch(serverMenu, menu => {
  unbindMenuListeners()
  if (!menu) return
  window.addEventListener('mousedown', closeOnOutside, true)
  window.addEventListener('contextmenu', closeOnOutside, true)
  window.addEventListener('keydown', closeOnEscape)
  window.addEventListener('blur', closeServerMenu)
  window.addEventListener('resize', closeServerMenu)
  window.addEventListener('wheel', closeServerMenu, true)
})
onBeforeUnmount(unbindMenuListeners)
function openFromServerMenu(kind) {
  const server = serverMenu.value?.server
  serverMenu.value = null
  if (server) requestOpen(kind, server)
}
function detailFromMenu() {
  const server = serverMenu.value?.server
  serverMenu.value = null
  if (server) detailTarget.value = server
}
function editDetail() {
  const server = detailTarget.value
  detailTarget.value = null
  if (server) emit('edit-server', server)
}
function editServerFromMenu() {
  const server = serverMenu.value?.server
  serverMenu.value = null
  if (server) emit('edit-server', server)
}
function copyPasswordFromMenu() {
  const server = serverMenu.value?.server
  serverMenu.value = null
  if (server) copyPassword(server)
}
function copyServerFromMenu() {
  const server = serverMenu.value?.server
  serverMenu.value = null
  if (server) emit('copy-server', server)
}
function deleteServerFromMenu() {
  const server = serverMenu.value?.server
  serverMenu.value = null
  if (server) deleteTarget.value = server
}
function chooseSessionKind(kind) {
  const server = newSessionTarget.value
  newSessionTarget.value = null
  if (server) requestOpen(kind, server)
}
function confirmDeleteServer() {
  const server = deleteTarget.value
  if (!server) return
  deleteTarget.value = null
  sessions.value = sessions.value.filter(session => session.serverId !== server.id)
  if (!sessions.value.length) currentPage.value = 0
  emit('delete-server', server)
}
function exportList() { emit('export-excel', filteredServers.value) }
function hasSession(server) { return sessions.value.some(session => session.serverId === server.id) }
</script>

<template>
  <div class="ssh-workspace">
    <aside class="ssh-rail">
      <div class="ssh-railhead"><b>服务器</b><span>{{ filteredServers.length }} / {{ servers.length }}</span></div>
      <input v-model="query" class="ssh-railsearch" placeholder="搜索名称、地址、标签" />
      <div class="ssh-tagfilter">
        <button type="button" class="ssh-tagchip" :class="{ active: !tagFilter }" @click="tagFilter = ''">全部<b>{{ servers.length }}</b></button>
        <button v-for="tag in railTags" :key="tag.name" type="button" class="ssh-tagchip" :class="{ active: tagFilter === tag.name }" @click="tagFilter = tagFilter === tag.name ? '' : tag.name">{{ tag.name }}<b>{{ tag.count }}</b></button>
        <button v-if="moreTags.length || tagMoreOpen" type="button" class="ssh-tagchip ssh-tagmore-btn" :class="{ active: tagMoreOpen }" @click="toggleTagMore">更多<b>{{ allTags.length }}</b></button>
      </div>
      <div v-if="tagMoreOpen" class="ssh-tagmore-panel">
        <div class="ssh-tagmore-head"><span>更多标签</span><button type="button" @click="tagMoreOpen = false; tagSearch = ''">收起</button></div>
        <input v-model="tagSearch" class="ssh-tagmore-search" placeholder="搜索标签" />
        <div class="ssh-tagmore-list">
          <button v-for="tag in searchedMoreTags" :key="tag.name" type="button" class="ssh-tagchip" :class="{ active: tagFilter === tag.name }" @click="selectTag(tag.name)">{{ tag.name }}<b>{{ tag.count }}</b></button>
          <p v-if="!searchedMoreTags.length" class="ssh-railempty">没有匹配标签</p>
        </div>
      </div>
      <button type="button" class="ssh-newserver ssh-newserver-top" @click="newServer">＋ 新建服务器</button>
      <div class="ssh-serverlist">
        <div v-for="server in filteredServers" :key="server.id" class="ssh-serverrow" :class="{ selected: server.id === selectedId }" role="button" tabindex="0" title="单击选择，双击依次打开终端和文件，右键打开会话" @click="selectServer(server)" @dblclick="handleServerDblClick(server)" @contextmenu.prevent="openServerMenu(server, $event)" @keydown.enter="selectServer(server)">
          <span class="ssh-serverdot" :class="{ active: hasSession(server) }"></span>
          <span class="ssh-servermain">
            <span class="ssh-serverhost" :title="server.host">{{ server.host }}</span>
            <span class="ssh-servername" :title="server.tags.length ? `${server.name} · ${server.tags.join('、')}` : server.name">{{ server.name }}<span v-for="tag in server.tags.slice(0, 2)" :key="tag" class="ssh-servertag">{{ tag }}</span><span v-if="server.tags.length > 2" class="ssh-servertagmore" :title="server.tags.join('、')">+{{ server.tags.length - 2 }}</span></span>
            <span v-if="server.note" class="ssh-servernote" :title="server.note">{{ server.note }}</span>
          </span>
        </div>
        <p v-if="!filteredServers.length" class="ssh-railempty">没有匹配的服务器</p>
      </div>
      <button type="button" class="ssh-version" :class="{ available: updateState.status === 'available' }" :title="updateState.status === 'available' ? `发现新版本 ${updateState.version}` : '查看更新'" @click="emit('open-update')">
        <span>v{{ version || '0.1.0' }}</span>
        <span v-if="updateState.status === 'available'" class="ssh-version-badge">新版本</span>
        <span v-else-if="updateState.status === 'downloading'" class="ssh-version-badge downloading">{{ updateState.progress || 0 }}%</span>
        <span v-else-if="updateState.status === 'ready'" class="ssh-version-badge ready">待安装</span>
        <span v-else-if="updateState.status === 'installing'" class="ssh-version-badge ready">安装中</span>
      </button>
    </aside>

    <main class="ssh-ws-main">
      <div class="ssh-toolbar">
        <div class="ssh-pagebar">
          <button type="button" :disabled="currentPage === 0" title="上一页" @click="setPage(currentPage - 1)">‹</button>
          <span>{{ currentPage + 1 }} / {{ pageCount }} 页</span>
          <button type="button" :disabled="currentPage >= pageCount - 1" title="下一页" @click="setPage(currentPage + 1)">›</button>
          <button type="button" title="所有会话" @click="openSessions">所有会话</button>
        </div>
        <div class="ssh-layout"><span>布局</span><button v-for="value in [1,2,4,6,9]" :key="value" type="button" :class="{ active: layout === value }" @click="setLayout(value)">{{ value }}</button></div>
        <label class="ssh-zoom"><span>文字</span><select :value="manualScale === null ? 'auto' : String(manualScale)" @change="changeScale"><option value="auto">自动</option><option value="0.7">70%</option><option value="0.8">80%</option><option value="0.9">90%</option><option value="1">100%</option><option value="1.1">110%</option><option value="1.25">125%</option></select><b>{{ Math.round(scale * 100) }}%</b></label>
        <span class="ssh-toolspacer"></span>
        <div class="ssh-topactions">
          <button type="button" class="theme-toggle" :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'" @click="emit('toggle-theme')">
            <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
              <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z" />
            </svg>
          </button>
          <button type="button" @click="emit('import-excel')">导入 Excel</button>
          <button type="button" @click="exportList">导出 Excel</button>
          <button type="button" @click="emit('open-commands')">常用指令</button>
          <button type="button" @click="emit('open-settings')">设置</button>
        </div>
      </div>

      <div class="ssh-grid" :class="[`g${layout}`, { maxed: maxedId }]" :style="{ '--tile-scale': scale }">
        <section v-for="(session, index) in sessions" :key="session.id" class="ssh-tile" :class="[session.kind === 'file' ? 'filetile' : 'termtile', { 'session-hidden': !isSessionVisible(index), focused: selectedId === session.serverId && maxedId !== session.id, maxed: maxedId === session.id, dragging: draggingId === session.id }]" @click="selectServer(serverFor(session) || session.server)" @dragover.prevent @drop="dropSession(session)">
          <div class="ssh-tile-inner">
            <div class="ssh-tilehead" draggable="true" @dragstart="dragStart(session, $event)" @dragend="dragEnd">
              <span class="ssh-draghandle">⋮⋮</span>
              <span class="ssh-ticon" :class="session.kind">{{ session.kind === 'file' ? 'F' : '>_' }}</span>
              <span class="ssh-tname">{{ sessionTitle(session) }}</span>
              <span class="ssh-tmeta" :title="sessionMeta(session) + (session.kind === 'file' ? ' · 文件管理' : '')">{{ session.kind === 'file' ? `文件管理 · ${sessionMeta(session)}` : sessionMeta(session) }}</span>
              <span class="ssh-theadspace"></span>
              <button type="button" class="ssh-tbtn" :title="maxedId === session.id ? '还原' : '放大'" @click.stop="toggleMax(session)">⤢</button>
              <button type="button" class="ssh-tbtn" title="关闭" @click.stop="closeSession(session)">×</button>
            </div>
            <div class="ssh-tilebody">
              <SshTerminal v-if="session.kind === 'terminal'" :session-id="session.id" :server="serverFor(session) || session.server" :sudo-password="serverFor(session)?.password || session.server.password" :commands="commands" :scale="scale" can-manage-commands @manage-commands="emit('open-commands')" @notice="showNotice" />
              <SshFileSession v-else :session-id="session.id" :server="serverFor(session) || session.server" @notice="showNotice" />
            </div>
          </div>
        </section>
        <div v-if="!pageSessions.length" class="ssh-empty-state">
          <span class="ssh-empty-state-icon">＋</span>
          <strong>{{ selectedServer ? `为 ${selectedServer.name} 打开会话` : '先选择左侧服务器' }}</strong>
          <p>终端和文件会话独立运行，可同时打开多个。</p>
          <div class="ssh-empty-state-actions">
            <button type="button" class="primary" :disabled="!selectedServer" @click="requestOpen('terminal', selectedServer)">打开终端</button>
            <button type="button" :disabled="!selectedServer" @click="requestOpen('file', selectedServer)">打开文件</button>
          </div>
        </div>
        <template v-else>
          <button v-for="index in emptySlots" :key="`empty-${index}`" type="button" class="ssh-empty" :disabled="!selectedServer" @click="openSessionPicker(selectedServer)">
            <span class="ssh-empty-plus">＋</span>
            <span class="ssh-empty-hint">新建会话</span>
          </button>
        </template>
        <div v-if="draggingId && !maxedId" class="ssh-drop-overlay" @dragover.prevent @dragleave.self="dragTarget = -1">
          <div class="ssh-drop-grid" :class="`g${layout}`">
            <div
              v-for="index in capacity"
              :key="`drop-slot-${index}`"
              class="ssh-drop-slot"
              :class="{ active: dragTarget === index - 1 }"
              @dragenter.prevent.stop="dragTarget = index - 1"
              @dragover.prevent.stop="dragTarget = index - 1"
              @drop.prevent.stop="dropSlot(index - 1)"
            >
              <span class="ssh-drop-slot-index">{{ index }}</span>
              <span class="ssh-drop-slot-name">{{ sessionForSlot(index - 1) ? sessionTitle(sessionForSlot(index - 1)) : '空位' }}</span>
            </div>
          </div>
        </div>
      </div>
    </main>

    <div v-if="confirmSession" class="um-overlay">
      <section class="um-dialog ssh-confirm-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="confirmSession = null">×</button>
        <h2>会话已存在</h2>
        <p>{{ confirmSession.server.name }} 已经打开了同类型会话。确认要再打开一个新的{{ confirmSession.kind === 'file' ? 'XFTP' : 'SSH 终端' }}会话吗？</p>
        <div class="um-dialog-actions"><button type="button" @click="confirmSession = null">取消</button><button type="button" class="um-primary" @click="confirmOpen">仍然打开</button></div>
      </section>
    </div>

    <div v-if="bothOpenTarget" class="um-overlay">
      <section class="um-dialog ssh-confirm-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="bothOpenTarget = null">×</button>
        <h2>会话已打开</h2>
        <p>{{ bothOpenTarget.name }} 的终端和文件会话都已打开。需要更多会话时，右键服务器选择“打开终端”或“打开文件”。</p>
        <div class="um-dialog-actions"><button type="button" class="um-primary" @click="bothOpenTarget = null">知道了</button></div>
      </section>
    </div>

    <div v-if="newSessionTarget" class="um-overlay">
      <section class="um-dialog ssh-session-picker" role="dialog" aria-modal="true" aria-label="新建会话">
        <button class="um-close" type="button" aria-label="关闭" @click="newSessionTarget = null">×</button>
        <h2>新建会话</h2>
        <p class="ssh-session-target">{{ newSessionTarget.name }} · {{ newSessionTarget.username }}@{{ newSessionTarget.host }}:{{ newSessionTarget.port }}</p>
        <div class="ssh-picker-actions">
          <button type="button" class="terminal" @click="chooseSessionKind('terminal')"><b>终端</b><span>打开 SSH 终端</span></button>
          <button type="button" class="file" @click="chooseSessionKind('file')"><b>文件</b><span>打开 XFTP 文件管理</span></button>
        </div>
        <div class="um-dialog-actions"><button type="button" @click="newSessionTarget = null">取消</button></div>
      </section>
    </div>

    <div v-if="detailTarget" class="um-overlay">
      <section class="um-dialog server-detail-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="detailTarget = null">×</button>
        <h2>{{ detailTarget.name }}</h2>
        <p class="server-detail-host">{{ detailTarget.host }}:{{ detailTarget.port }}</p>
        <div class="server-detail-grid">
          <div class="server-detail-row"><span>账号</span><b>{{ detailTarget.username }}</b></div>
          <div class="server-detail-row"><span>认证</span><b>{{ detailTarget.authType === 'key' ? 'SSH 私钥' : '密码' }}</b></div>
          <div v-if="detailTarget.authType === 'key'" class="server-detail-row"><span>私钥口令</span><b>{{ detailTarget.passphrase ? '已设置' : '未设置' }}</b></div>
          <div v-if="detailTarget.password" class="server-detail-row">
            <span>{{ detailTarget.authType === 'key' ? '密码（sudo）' : '密码' }}</span>
            <code>{{ detailTarget.password }}</code>
            <button type="button" class="server-detail-copy" @click="copyPassword(detailTarget)">复制</button>
          </div>
          <div class="server-detail-row">
            <span>标签</span>
            <span v-if="detailTarget.tags?.length" class="server-detail-tags"><i v-for="tag in detailTarget.tags" :key="tag">{{ tag }}</i></span>
            <b v-else>—</b>
          </div>
          <div class="server-detail-row"><span>主机指纹</span><b>{{ detailTarget.strictHostKey === false ? '不校验' : '严格校验' }}</b></div>
          <div v-if="detailTarget.note" class="server-detail-row server-detail-note-row"><span>备注</span><p>{{ detailTarget.note }}</p></div>
        </div>
        <div class="um-dialog-actions">
          <button type="button" @click="detailTarget = null">关闭</button>
          <button type="button" class="um-primary" @click="editDetail">编辑</button>
        </div>
      </section>
    </div>

    <div v-if="deleteTarget" class="um-overlay">
      <section class="um-dialog ssh-confirm-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="deleteTarget = null">×</button>
        <h2>删除服务器</h2>
        <p>删除 {{ deleteTarget.name }}？该服务器的会话也会一并关闭，此操作无法撤销。</p>
        <div class="um-dialog-actions"><button type="button" @click="deleteTarget = null">取消</button><button type="button" class="um-danger-button" @click="confirmDeleteServer">确认删除</button></div>
      </section>
    </div>

    <div v-if="sessionsOpen" class="um-overlay">
      <section class="um-dialog ssh-sessions-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="sessionsOpen = false">×</button>
        <h2>所有会话</h2>
        <p class="ssh-filedir">点击任意会话跳转到对应页面。</p>
        <div class="ssh-sessions-list">
          <button v-for="row in allSessions" :key="row.session.id" type="button" class="ssh-session-row" :class="{ file: row.session.kind === 'file' }" @click="jumpToSession(row)">
            <span class="ssh-session-icon">{{ row.session.kind === 'file' ? 'F' : '>_' }}</span>
            <span class="ssh-session-name">{{ sessionTitle(row.session) }}</span>
            <span class="ssh-session-route">第 {{ row.page + 1 }} 页</span>
          </button>
          <p v-if="!allSessions.length" class="ssh-railempty">暂无会话</p>
        </div>
        <div class="um-dialog-actions"><button type="button" @click="sessionsOpen = false">关闭</button></div>
      </section>
    </div>

    <Teleport to="body">
      <div v-if="serverMenu" class="server-menu" :style="{ left: serverMenu.x + 'px', top: serverMenu.y + 'px' }" role="menu">
        <div class="server-menu-head">{{ serverMenu.server.name }}</div>
        <button type="button" role="menuitem" @click="openFromServerMenu('terminal')"><span class="server-menu-icon">>_</span>打开终端</button>
        <button type="button" role="menuitem" @click="openFromServerMenu('file')"><span class="server-menu-icon file">F</span>打开文件</button>
        <div class="context-menu-sep"></div>
        <button type="button" role="menuitem" @click="detailFromMenu">查看详情</button>
        <button type="button" role="menuitem" @click="editServerFromMenu">编辑服务器</button>
        <button type="button" role="menuitem" @click="copyServerFromMenu">复制服务器</button>
        <button v-if="serverMenu.server.password" type="button" role="menuitem" @click="copyPasswordFromMenu">复制密码</button>
        <div class="context-menu-sep"></div>
        <button type="button" class="danger" role="menuitem" @click="deleteServerFromMenu">删除服务器</button>
      </div>
    </Teleport>
  </div>
</template>
