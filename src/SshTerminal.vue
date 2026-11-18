<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import '@xterm/xterm/css/xterm.css'

const props = defineProps({
  sessionId: { type: String, required: true },
  server: { type: Object, required: true },
  sudoPassword: { type: String, default: '' },
  commands: { type: Array, default: () => [] },
  canManageCommands: Boolean,
  title: { type: String, default: 'SSH 终端' },
  subtitle: { type: String, default: '' },
})
const emit = defineEmits(['manage-commands', 'notice'])

const host = ref(null)
const state = ref('connecting')
const error = ref('')
const selectedCommand = ref('')
const paramOpen = ref(false)
const paramCommand = ref(null)
const paramNames = ref([])
const paramValues = ref({})
const paramError = ref('')
const sudoState = ref('idle')
const terminalMenu = ref(null)
const hasSelection = ref(false)
let terminal = null
let fit = null
let observer = null
let unsubscribers = []
let sudoTimer = 0
let sudoDecoder = null
let sudoBuffer = ''

const selected = computed(() => props.commands.find(command => command.id === selectedCommand.value))

onMounted(() => mount())
onBeforeUnmount(() => dispose())

async function mount() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  if (!host.value) return
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 15,
    fontFamily: 'ui-monospace, Consolas, monospace',
    scrollback: 3000,
    theme: {
      background: '#0f141c', foreground: '#f4f7fb',
      cursor: '#7fb2ff', cursorAccent: '#0f141c',
      selectionBackground: 'rgba(127, 178, 255, 0.35)', selectionForeground: '#ffffff',
    },
  })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host.value)
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') { copySelection(); return false }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') { pasteClipboard(); return false }
    return true
  })
  fitTerminal()
  terminal.focus()
  terminal.onData(data => {
    if (state.value === 'ready') window.shellDeck.terminal.input(props.sessionId, data)
  })
  terminal.onResize(({ cols, rows }) => sendResize(cols, rows))
  terminal.onSelectionChange(() => { hasSelection.value = terminal?.hasSelection() || false })
  observer = new ResizeObserver(() => fitTerminal())
  observer.observe(host.value)
  connect()
}

function plainServer(server) {
  return JSON.parse(JSON.stringify(server || {}))
}
function connect() {
  state.value = 'connecting'
  error.value = ''
  resetSudo()
  subscribe()
  window.shellDeck.terminal.open({
    sessionId: props.sessionId,
    server: plainServer(props.server),
    cols: terminal?.cols || 80,
    rows: terminal?.rows || 24,
  }).catch(err => {
    error.value = err.message || '连接失败'
    state.value = 'error'
  })
}

function subscribe() {
  unsubscribeAll()
  unsubscribers = [
    window.shellDeck.on('terminal:data', payload => {
      if (payload.sessionId !== props.sessionId) return
      terminal?.write(payload.data)
      watchSudoOutput(payload.data)
    }),
    window.shellDeck.on('terminal:ready', payload => {
      if (payload.sessionId !== props.sessionId) return
      state.value = 'ready'
      fitTerminal()
      sendResize(terminal?.cols || 80, terminal?.rows || 24)
      terminal?.focus()
    }),
    window.shellDeck.on('terminal:closed', payload => {
      if (payload.sessionId !== props.sessionId) return
      resetSudo()
      if (state.value !== 'error') state.value = 'closed'
    }),
    window.shellDeck.on('terminal:error', payload => {
      if (payload.sessionId !== props.sessionId) return
      resetSudo()
      error.value = payload.message || '连接失败'
      state.value = 'error'
    }),
  ]
}

function unsubscribeAll() {
  for (const off of unsubscribers) { try { off() } catch { /* already gone */ } }
  unsubscribers = []
}
function closeTerminalMenu() { terminalMenu.value = null }
function terminalMenuInside(event) {
  return event.target instanceof Element && Boolean(event.target.closest('.context-menu'))
}
function closeTerminalMenuOutside(event) {
  if (!terminalMenu.value || terminalMenuInside(event)) return
  closeTerminalMenu()
}
function closeTerminalMenuEscape(event) {
  if (event.key === 'Escape') closeTerminalMenu()
}
function unbindTerminalMenu() {
  window.removeEventListener('mousedown', closeTerminalMenuOutside, true)
  window.removeEventListener('contextmenu', closeTerminalMenuOutside, true)
  window.removeEventListener('keydown', closeTerminalMenuEscape)
  window.removeEventListener('blur', closeTerminalMenu)
  window.removeEventListener('resize', closeTerminalMenu)
  window.removeEventListener('wheel', closeTerminalMenu, true)
}
watch(terminalMenu, menu => {
  unbindTerminalMenu()
  if (!menu) return
  window.addEventListener('mousedown', closeTerminalMenuOutside, true)
  window.addEventListener('contextmenu', closeTerminalMenuOutside, true)
  window.addEventListener('keydown', closeTerminalMenuEscape)
  window.addEventListener('blur', closeTerminalMenu)
  window.addEventListener('resize', closeTerminalMenu)
  window.addEventListener('wheel', closeTerminalMenu, true)
})
function openTerminalMenu(event) {
  hasSelection.value = terminal?.hasSelection() || false
  const width = 190
  const height = 190
  terminalMenu.value = {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  }
}
function menuCopy() {
  closeTerminalMenu()
  copySelection()
}
function menuPaste() {
  closeTerminalMenu()
  pasteClipboard()
}
function menuSelectAll() {
  terminal?.selectAll()
  hasSelection.value = terminal?.hasSelection() || false
  closeTerminalMenu()
}
function menuClear() {
  closeTerminalMenu()
  sendKey('\u000c')
}

function reconnect() {
  window.shellDeck.terminal.close(props.sessionId).catch(() => {})
  connect()
}
function dispose() {
  resetSudo()
  unbindTerminalMenu()
  closeTerminalMenu()
  unsubscribeAll()
  if (observer) { observer.disconnect(); observer = null }
  window.shellDeck.terminal.close(props.sessionId).catch(() => {})
  if (terminal) { terminal.dispose(); terminal = null }
  fit = null
}
function fitTerminal() { try { fit?.fit() } catch { /* Hidden or zero sized. */ } }
function sendResize(cols, rows) {
  if (state.value === 'ready') window.shellDeck.terminal.resize(props.sessionId, cols, rows).catch(() => {})
}
function sendKey(data) {
  if (state.value !== 'ready') { emit('notice', '终端尚未连接'); return }
  window.shellDeck.terminal.input(props.sessionId, data).catch(() => {})
  terminal?.focus()
}
function clearSudoTimer() {
  if (sudoTimer) { clearTimeout(sudoTimer); sudoTimer = 0 }
}
function resetSudo() {
  clearSudoTimer()
  sudoState.value = 'idle'
  sudoBuffer = ''
  sudoDecoder = null
}
function armSudoTimer(ms) {
  clearSudoTimer()
  sudoTimer = setTimeout(() => {
    sudoTimer = 0
    if (sudoState.value === 'wait') {
      resetSudo()
      emit('notice', '未看到 sudo 密码提示：如果已免密进入 root 可忽略，否则请手动输入')
    } else if (sudoState.value === 'sent') {
      resetSudo()
    }
  }, ms)
}
function sudoSwitch() {
  if (state.value !== 'ready') { emit('notice', '终端尚未连接'); return }
  sudoBuffer = ''
  sudoDecoder = new TextDecoder()
  sudoState.value = 'wait'
  armSudoTimer(20000)
  sendKey("sudo -p '[sudo] password: ' -i\r")
}
function watchSudoOutput(bytes) {
  if (sudoState.value === 'idle' || !sudoDecoder) return
  sudoBuffer = (sudoBuffer + sudoDecoder.decode(bytes, { stream: true })).slice(-800)
  const clean = sudoBuffer.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  if (sudoState.value === 'wait' && /(?:^|[\r\n])(?:\[sudo\] )?password[^\r\n]{0,40}:\s*$/.test(clean)) {
    sudoBuffer = ''
    if (!props.sudoPassword) {
      resetSudo()
      emit('notice', 'sudo 需要密码，服务器清单里没有保存密码，请手动输入')
      return
    }
    sendKey(props.sudoPassword + '\r')
    sudoState.value = 'sent'
    armSudoTimer(8000)
    emit('notice', '已自动填入 sudo 密码')
    return
  }
  if (sudoState.value === 'sent' && /(?:sorry|try again|incorrect|not in the sudoers|密码不正确|密码错误|认证失败)/i.test(clean)) {
    sendKey('\u0003')
    resetSudo()
    emit('notice', 'sudo 密码可能不正确，已中断；请更新服务器清单密码或手动输入')
  }
}
async function copySelection() {
  const text = terminal?.getSelection() || ''
  if (!text) { emit('notice', '先在终端里选中要复制的文字'); return }
  try { await window.shellDeck.clipboard.write(text); emit('notice', '已复制') }
  catch { emit('notice', '复制失败') }
}
async function pasteClipboard() {
  try {
    const text = await window.shellDeck.clipboard.read()
    if (text) sendKey(text)
  } catch {
    emit('notice', '无法读取剪贴板')
  }
}
function parameterNames(text) {
  const names = []
  const pattern = /\{\{\s*([^{}\r\n]+?)\s*\}\}/g
  let match
  while ((match = pattern.exec(text || ''))) {
    const name = match[1].trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}
function fillParameters(text, values) {
  return String(text || '').replace(/\{\{\s*([^{}\r\n]+?)\s*\}\}/g, (_, raw) => values[raw.trim()] ?? '')
}
function executeCommand(command, values) {
  const text = fillParameters(command.body, values).replace(/\r\n/g, '\n')
  sendKey(text + '\r')
}
function runCommand() {
  const command = selected.value
  if (!command) { emit('notice', '先选择一条常用指令'); return }
  const names = parameterNames(command.body)
  if (!names.length) { executeCommand(command, {}); return }
  paramCommand.value = command
  paramNames.value = names
  paramValues.value = Object.fromEntries(names.map(name => [name, '']))
  paramError.value = ''
  paramOpen.value = true
}
function closeParameters() {
  paramOpen.value = false
  paramCommand.value = null
  paramError.value = ''
}
function confirmParameters() {
  const command = paramCommand.value
  if (!command) return
  const missing = paramNames.value.filter(name => !String(paramValues.value[name] ?? '').trim())
  if (missing.length) { paramError.value = '请填写：' + missing.join('、'); return }
  paramOpen.value = false
  executeCommand(command, { ...paramValues.value })
  paramCommand.value = null
  paramError.value = ''
}
</script>

<template>
  <div class="ssh-terminal-embedded">
    <section class="ssh-terminal-panel">
      <div class="ssh-termbar">
        <button type="button" title="中断当前命令" @click="sendKey('\u0003')">Ctrl+C</button>
        <button type="button" title="退出当前会话" @click="sendKey('\u0004')">Ctrl+D</button>
        <button type="button" title="清屏" @click="sendKey('\u000c')">Ctrl+L</button>
        <button type="button" title="命令补全" @click="sendKey('\t')">Tab</button>
        <button type="button" title="发送 Esc" @click="sendKey('\u001b')">Esc</button>
        <button type="button" title="上一条历史命令" @click="sendKey('\u001b[A')">↑</button>
        <button type="button" title="下一条历史命令" @click="sendKey('\u001b[B')">↓</button>
        <button
          type="button"
          class="ssh-sudobtn"
          :class="{ active: sudoState !== 'idle' }"
          :disabled="sudoState !== 'idle' || state !== 'ready'"
          title="发送 sudo -i，出现密码提示时自动填入服务器清单里的登录密码"
          @click="sudoSwitch"
        >{{ sudoState === 'wait' ? '等待密码…' : sudoState === 'sent' ? '已发密码' : 'sudo -i' }}</button>
        <button type="button" @click="pasteClipboard">粘贴</button>
        <button type="button" @click="copySelection">复制</button>
        <span class="ssh-termhint">Ctrl+Shift+C 复制 · Ctrl+Shift+V 粘贴</span>
      </div>
      <div v-if="commands.length || canManageCommands" class="ssh-cmdbar">
        <select v-model="selectedCommand" class="ssh-cmdselect" aria-label="常用指令">
          <option value="">选择常用指令…</option>
          <option v-for="command in commands" :key="command.id" :value="command.id">{{ command.kind === 'script' ? '脚本' : '命令' }} · {{ command.name }}</option>
        </select>
        <button type="button" class="ssh-cmdrun" :disabled="!selected || state !== 'ready'" @click="runCommand">执行</button>
        <button v-if="canManageCommands" type="button" class="ssh-cmdmanage" @click="emit('manage-commands')">管理指令</button>
      </div>
      <div ref="host" class="pv-terminal" @contextmenu.prevent="openTerminalMenu($event)">
        <div v-if="state !== 'ready'" class="pv-terminal-mask">
          <template v-if="state === 'connecting'"><span>正在连接…</span><small>最多等待 15 秒</small></template>
          <template v-else-if="state === 'error'"><span class="pv-terminal-error">{{ error }}</span><button class="pv-linkbtn" @click="reconnect">重试</button></template>
          <template v-else-if="state === 'closed'"><span>连接已断开</span><button class="pv-linkbtn" @click="reconnect">重新连接</button></template>
        </div>
      </div>
    </section>
    <Teleport to="body">
      <div v-if="terminalMenu" class="context-menu" :style="{ left: terminalMenu.x + 'px', top: terminalMenu.y + 'px' }" role="menu">
        <div class="context-menu-head">终端</div>
        <button type="button" :disabled="!hasSelection" @click="menuCopy">复制</button>
        <button type="button" :disabled="state !== 'ready'" @click="menuPaste">粘贴</button>
        <button type="button" @click="menuSelectAll">全选</button>
        <button type="button" :disabled="state !== 'ready'" @click="menuClear">清屏</button>
      </div>
      <div v-if="paramOpen" class="um-overlay ssh-param-overlay">
        <section class="um-dialog ssh-param-dialog" role="dialog" aria-modal="true">
          <button class="um-close" aria-label="关闭" @click="closeParameters">×</button>
          <h2>填写运行参数</h2>
          <p class="ssh-filedir">{{ paramCommand?.name }}</p>
          <label v-for="name in paramNames" :key="name">{{ name }}
            <input v-model="paramValues[name]" @keyup.enter="confirmParameters" />
          </label>
          <p class="ssl-hint">值会按原样插入；包含空格或特殊字符时，请在指令里自行加引号。</p>
          <p v-if="paramError" class="form-error">{{ paramError }}</p>
          <div class="um-dialog-actions">
            <button type="button" @click="closeParameters">取消</button>
            <button type="button" class="um-primary" @click="confirmParameters">执行</button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
