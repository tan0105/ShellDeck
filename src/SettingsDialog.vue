<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  open: Boolean,
  info: { type: Object, default: () => ({}) },
  dataError: { type: String, default: '' },
  dataBusy: Boolean,
})
const emit = defineEmits(['close', 'backup', 'restore', 'open-data'])

const confirmRestore = ref(false)

watch(() => props.open, open => {
  if (open) confirmRestore.value = false
})

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
          <div class="settings-head"><b>更新</b></div>
          <p class="settings-muted">文件夹版不执行应用内替换。更新方式：退出程序后，用新版本的 runtime 目录覆盖旧目录，data 目录保持不变。自动更新方案后续再设计。</p>
        </section>

        <div class="um-dialog-actions"><button type="button" @click="emit('close')">关闭</button></div>
      </section>
    </div>
  </Teleport>
</template>
