<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  open: Boolean,
  commands: { type: Array, default: () => [] },
  busy: Boolean,
  error: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save', 'remove'])

const form = reactive({ id: '', name: '', kind: 'command', body: '' })
const editing = ref(false)
const pendingDelete = ref(null)
const localError = ref('')
const query = ref('')

const filteredCommands = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.commands
  return props.commands.filter(command => {
    const kind = command.kind === 'script' ? '脚本' : '命令'
    return command.name.toLowerCase().includes(keyword)
      || command.body.toLowerCase().includes(keyword)
      || kind.includes(keyword)
  })
})

watch(() => props.open, open => {
  if (!open) return
  reset()
  query.value = ''
  pendingDelete.value = null
})
watch(() => props.commands, () => {
  if (!editing.value) return
  if (!props.commands.some(command => command.id === form.id)) reset()
})

function reset() {
  Object.assign(form, { id: '', name: '', kind: 'command', body: '' })
  editing.value = false
  localError.value = ''
}
function edit(command) {
  Object.assign(form, { id: command.id, name: command.name, kind: command.kind, body: command.body })
  editing.value = true
  localError.value = ''
  pendingDelete.value = null
}
function submit() {
  if (!form.name.trim()) { localError.value = '请填写指令名称'; return }
  if (!form.body.trim()) { localError.value = '请填写指令内容'; return }
  localError.value = ''
  emit('save', { id: form.id || undefined, name: form.name, kind: form.kind, body: form.body })
}
function askRemove(command) {
  pendingDelete.value = command
}
function confirmRemove() {
  const command = pendingDelete.value
  pendingDelete.value = null
  if (command) emit('remove', command.id)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="um-overlay">
      <section class="um-dialog cd-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2>常用指令</h2>
        <p class="sd-sub">命令直接在当前 shell 执行；脚本按当前交互 shell 逐行发送，保留当前目录和环境变量。</p>
        <div class="cd-layout">
          <div class="cd-list">
            <div class="cd-listhead"><b>已保存</b><button type="button" class="ssh-softbtn" @click="reset">＋ 新建</button></div>
            <input v-model="query" class="cd-search" type="search" placeholder="搜索名称或内容" spellcheck="false" />
            <div class="cd-items">
              <button v-for="command in filteredCommands" :key="command.id" type="button" class="cd-item" :class="{ active: form.id === command.id }" @click="edit(command)">
                <span class="cd-kind">{{ command.kind === 'script' ? '脚本' : '命令' }}</span>
                <span class="cd-name">{{ command.name }}</span>
                <span class="cd-remove" title="删除" @click.stop="askRemove(command)">×</span>
              </button>
              <p v-if="!commands.length" class="ssh-railempty">还没有常用指令</p>
              <p v-else-if="!filteredCommands.length" class="ssh-railempty">没有匹配的指令</p>
            </div>
          </div>
          <div class="cd-editor">
            <label class="sd-field">名称<input v-model="form.name" maxlength="60" placeholder="例如：查看磁盘" /></label>
            <label class="sd-field">类型<select v-model="form.kind"><option value="command">命令</option><option value="script">脚本</option></select></label>
            <label class="sd-field">内容<textarea v-model="form.body" class="cd-body" spellcheck="false" placeholder="df -h&#10;或包含 {{参数}} 的指令"></textarea></label>
            <p class="ssl-hint">支持 &#123;&#123;参数名&#125;&#125;，执行前会弹窗填写。</p>
            <p v-if="localError || error" class="form-error">{{ localError || error }}</p>
            <div class="cd-actions">
              <button v-if="editing" type="button" @click="reset">取消编辑</button>
              <button type="button" class="um-primary" :disabled="busy" @click="submit">{{ busy ? '保存中…' : (editing ? '保存修改' : '添加指令') }}</button>
            </div>
            <div v-if="pendingDelete" class="cd-confirm">
              <span>删除「{{ pendingDelete.name }}」？</span>
              <button type="button" class="um-danger-button" @click="confirmRemove">确认删除</button>
              <button type="button" @click="pendingDelete = null">取消</button>
            </div>
          </div>
        </div>
        <div class="um-dialog-actions"><button type="button" @click="emit('close')">关闭</button></div>
      </section>
    </div>
  </Teleport>
</template>
