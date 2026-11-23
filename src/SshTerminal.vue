<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import '@xterm/xterm/css/xterm.css'

const props = defineProps({
  sessionId: { type: String, required: true },
  server: { type: Object, required: true },
  sudoPassword: { type: String, default: '' },
  commands: { type: Array, default: () => [] },
  canManageCommands: Boolean,
  title: { type: String, default: 'SSH 终端' },
  subtitle: { type: String, default: '' },
  scale: { type: Number, default: 1 },
})
const emit = defineEmits(['manage-commands', 'notice'])

const host = ref(null)
const state = ref('connecting')
const error = ref('')
const selectedCommand = ref('')
const cmdInput = ref(null)
const cmdOpen = ref(false)
const cmdQuery = ref('')
const cmdActive = ref(0)
const cmdBox = ref({ left: 8, top: 8, width: 260, maxHeight: 240 })
const paramOpen = ref(false)
const paramInputs = ref([])
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
const selectedLabel = computed(() => commandLabel(selected.value))
const cmdMatches = computed(() => {
  const query = cmdQuery.value.trim()
  if (!query) return props.commands
  return props.commands
    .map(command => ({ command, score: commandScore(command, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name, 'zh-CN'))
    .map(item => item.command)
})
watch(cmdMatches, matches => {
  if (cmdActive.value >= matches.length) cmdActive.value = 0
})
watch(() => props.commands, list => {
  if (selectedCommand.value && !list.some(command => command.id === selectedCommand.value)) {
    selectedCommand.value = ''
    cmdQuery.value = ''
  }
})
watch(selectedLabel, label => {
  if (!cmdOpen.value) cmdQuery.value = label
})

function commandLabel(command) {
  return command ? `${command.kind === 'script' ? '脚本' : '命令'} · ${command.name}` : ''
}
function fuzzyScore(text, query) {
  const haystack = String(text || '').toLowerCase()
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return 1
  let score = 0
  let from = 0
  let previous = -2
  for (const char of needle) {
    const index = haystack.indexOf(char, from)
    if (index < 0) return 0
    score += index === previous + 1 ? 4 : 1
    if (index === 0) score += 4
    previous = index
    from = index + 1
  }
  return score
}
function commandScore(command, query) {
  const kind = command.kind === 'script' ? '脚本' : '命令'
  return Math.max(
    fuzzyScore(command.name, query),
    fuzzyScore(`${kind} ${command.name}`, query) - 2,
  )
}
function updateCmdBox() {
  if (!cmdInput.value) return
  const rect = cmdInput.value.getBoundingClientRect()
  const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  const openUp = spaceBelow < 150 && spaceAbove > spaceBelow
  const maxHeight = Math.max(96, Math.min(280, openUp ? spaceAbove : spaceBelow))
  cmdBox.value = {
    left,
    width,
    maxHeight,
    top: openUp ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 6,
  }
}
function openCmdCombo() {
  cmdOpen.value = true
  cmdActive.value = 0
  if (selected.value) cmdQuery.value = ''
  updateCmdBox()
}
function closeCmdCombo() {
  cmdOpen.value = false
  cmdQuery.value = selected.value ? selectedLabel.value : ''
  cmdActive.value = 0
}
function onCmdInput() {
  selectedCommand.value = ''
  cmdOpen.value = true
  cmdActive.value = 0
  updateCmdBox()
}
function onCmdClick() {
  if (!cmdOpen.value) openCmdCombo()
}
function chooseCommand(command) {
  selectedCommand.value = command.id
  cmdQuery.value = commandLabel(command)
  cmdOpen.value = false
  cmdActive.value = 0
}
function cmdKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (!cmdOpen.value) openCmdCombo()
    else if (cmdMatches.value.length) cmdActive.value = (cmdActive.value + 1) % cmdMatches.value.length
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (!cmdOpen.value) openCmdCombo()
    else if (cmdMatches.value.length) cmdActive.value = (cmdActive.value - 1 + cmdMatches.value.length) % cmdMatches.value.length
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (cmdOpen.value) {
      const command = cmdMatches.value[cmdActive.value] || cmdMatches.value[0]
      if (command) chooseCommand(command)
      return
    }
    if (selected.value) runCommand()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeCmdCombo()
    cmdInput.value?.blur()
  }
}
function cmdInside(event) {
  return event.target instanceof Element && Boolean(event.target.closest('.ssh-cmdcombo, .ssh-cmdpop'))
}
function closeCmdOutside(event) {
  if (!cmdOpen.value || cmdInside(event)) return
  closeCmdCombo()
}
function closeCmdLayout() {
  if (cmdOpen.value) closeCmdCombo()
}
function unbindCmdCombo() {
  window.removeEventListener('mousedown', closeCmdOutside, true)
  window.removeEventListener('resize', closeCmdLayout)
  window.removeEventListener('scroll', closeCmdLayout)
}
watch(cmdOpen, open => {
  unbindCmdCombo()
  if (!open) return
  window.addEventListener('mousedown', closeCmdOutside, true)
  window.addEventListener('resize', closeCmdLayout)
  window.addEventListener('scroll', closeCmdLayout)
})

function terminalFontSize(value = props.scale) {
  return Math.max(9, Math.round(15 * (Number(value) || 1)))
}

watch(paramOpen, open => {
  if (!open) return
  nextTick(() => {
    const input = Array.isArray(paramInputs.value) ? paramInputs.value[0] : paramInputs.value
    input?.focus()
    input?.select?.()
  })
})

watch(() => props.scale, value => {
  if (!terminal) return
  terminal.options.fontSize = terminalFontSize(value)
  requestAnimationFrame(() => fitTerminal())
})

onMounted(() => mount())
onBeforeUnmount(() => dispose())

async function mount() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
  if (!host.value) return
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: terminalFontSize(),
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
  unbindCmdCombo()
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
        <div class="ssh-cmdcombo">
          <input
            ref="cmdInput"
            v-model="cmdQuery"
            class="ssh-cmdsearch"
            type="text"
            placeholder="搜索常用指令…"
            aria-label="搜索常用指令"
            autocomplete="off"
            spellcheck="false"
            @focus="openCmdCombo"
            @click="onCmdClick"
            @input="onCmdInput"
            @keydown="cmdKeydown"
            @keydown.tab="closeCmdCombo"
          />
        </div>
        <button type="button" class="ssh-cmdrun" :disabled="!selected || state !== 'ready'" @click="runCommand">执行</button>
        <button v-if="canManageCommands" type="button" class="ssh-cmdmanage" @click="emit('manage-commands')">管理指令</button>
        <Teleport to="body">
          <div v-if="cmdOpen" class="ssh-cmdpop" :style="{ left: cmdBox.left + 'px', top: cmdBox.top + 'px', width: cmdBox.width + 'px', maxHeight: cmdBox.maxHeight + 'px' }" role="listbox" aria-label="常用指令搜索结果">
            <button
              v-for="(command, index) in cmdMatches"
              :key="command.id"
              type="button"
              class="ssh-cmdoption"
              :class="{ active: index === cmdActive, script: command.kind === 'script' }"
              role="option"
              :aria-selected="index === cmdActive"
              @mousedown.prevent="chooseCommand(command)"
              @mouseenter="cmdActive = index"
            >
              <span class="ssh-cmdkind">{{ command.kind === 'script' ? '脚本' : '命令' }}</span>
              <span class="ssh-cmdname">{{ command.name }}</span>
            </button>
            <p v-if="!cmdMatches.length" class="ssh-cmdempty">没有匹配指令</p>
          </div>
        </Teleport>
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
            <input ref="paramInputs" v-model="paramValues[name]" @keyup.enter="confirmParameters" />
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
