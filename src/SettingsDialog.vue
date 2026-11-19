<script setup>
import { computed, ref, watch } from 'vue'
import updateConfig from '../shared/update-config.json'

const props = defineProps({
  open: Boolean,
  info: { type: Object, default: () => ({}) },
  dataError: { type: String, default: '' },
  dataBusy: Boolean,
  acceleratorMode: { type: String, default: 'auto' },
  acceleratorCustom: { type: String, default: '' },
  autoCheck: { type: Boolean, default: true },
  updateState: { type: Object, default: () => ({ status: 'idle' }) },
  updateError: { type: String, default: '' },
  busy: Boolean,
})
const emit = defineEmits(['close', 'backup', 'restore', 'open-data', 'save-accelerator', 'toggle-auto', 'check', 'open-update'])

const confirmRestore = ref(false)
const accelMode = ref('auto')
const accelCustom = ref('')
const accelError = ref('')

const statusText = computed(() => ({
  idle: '尚未检查',
  checking: '正在检查更新…',
  available: `发现新版本 v${props.updateState.version || ''}`,
  'up-to-date': '已是最新版本',
  downloading: `正在下载 ${props.updateState.progress || 0}%`,
  ready: '更新已下载',
  installing: '正在重启安装…',
  error: '检查更新失败',
}[props.updateState.status] || ''))

watch(() => props.open, open => {
  if (!open) return
  confirmRestore.value = false
  accelMode.value = props.acceleratorMode
  accelCustom.value = props.acceleratorCustom
  accelError.value = ''
})

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
function saveAccelerator() {
  const custom = accelCustom.value.trim()
  if (accelMode.value === 'custom' && !/^https:\/\//i.test(custom)) {
    accelError.value = '请填写 HTTPS 加速前缀，例如 https://ghproxy.net/'
    return
  }
  accelError.value = ''
  emit('save-accelerator', { mode: accelMode.value, custom })
}

function requestRestore() { confirmRestore.value = true }
function doRestore() { confirmRestore.value = false; emit('restore') }
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="um-overlay">
      <section class="um-dialog settings-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2>设置</h2>
        <p class="sd-sub">数据只保存在本机，不上传任何信息。</p>

        <section class="settings-section">
          <div class="settings-head"><b>数据</b><span>ShellDeck {{ info.version || '' }}</span></div>
          <div class="settings-info">
            <span>数据目录</span>
            <code>{{ info.dataDir || '—' }}</code>
          </div>
          <div class="settings-actions">
            <button type="button" class="ssh-softbtn" @click="emit('open-data')">打开数据目录</button>
            <button type="button" class="ssh-softbtn" :disabled="dataBusy" @click="emit('backup')">{{ dataBusy ? '处理中…' : '备份数据库' }}</button>
            <button type="button" class="ssh-softbtn danger" :disabled="dataBusy" @click="requestRestore">从备份恢复</button>
          </div>
          <div v-if="confirmRestore" class="settings-confirm">
            <p>恢复会用选中的数据库文件覆盖当前数据，并先自动保存一份当前数据库。确定继续？</p>
            <div><button type="button" class="um-danger-button" @click="doRestore">选择备份并恢复</button><button type="button" @click="confirmRestore = false">取消</button></div>
          </div>
          <p v-if="dataError" class="form-error">{{ dataError }}</p>
        </section>

        <section class="settings-section">
          <div class="settings-head"><b>更新</b><span>GitHub Releases</span></div>
          <div class="settings-github">
            <select v-model="accelMode">
              <option value="auto">自动（直连失败后尝试加速）</option>
              <option value="direct">GitHub 直连</option>
              <option v-for="item in updateConfig.accelerators" :key="item.id" :value="item.id">{{ item.name }}</option>
              <option value="custom">自定义加速前缀</option>
            </select>
            <button type="button" class="ssh-softbtn" :disabled="busy" @click="saveAccelerator">保存</button>
          </div>
          <div v-if="accelMode === 'custom'" class="settings-github settings-accel-custom">
            <input v-model="accelCustom" placeholder="https://example.com/" maxlength="300" @keydown.enter.prevent="saveAccelerator" />
          </div>
          <label class="settings-auto"><input type="checkbox" :checked="autoCheck" @change="emit('toggle-auto', $event.target.checked)" />启动后自动检查</label>
          <div class="settings-update-line">
            <b>{{ statusText }}</b>
            <span v-if="updateState.source">· {{ updateState.source }}</span>
            <span v-if="updateState.checkedAt" class="settings-muted">上次检查 {{ formatTime(updateState.checkedAt) }}</span>
          </div>
          <p v-if="accelError || updateError" class="form-error">{{ accelError || updateError }}</p>
          <div class="settings-actions">
            <button type="button" class="ssh-softbtn" :disabled="busy || updateState.status === 'checking'" @click="emit('check')">检查更新</button>
            <button v-if="updateState.status === 'available' || updateState.status === 'ready'" type="button" class="ssh-primarybtn" @click="emit('open-update')">查看更新</button>
          </div>
          <p class="ssl-hint">自动模式会先直连 GitHub，失败后依次尝试内置加速。普通更新只下载 app.asar；Electron、原生模块或入口启动器变化时需要整包手动更新。</p>
        </section>

        <div class="um-dialog-actions"><button type="button" @click="emit('close')">关闭</button></div>
      </section>
    </div>
  </Teleport>
</template>
