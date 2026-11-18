<script setup>
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps({
  open: Boolean,
  server: { type: Object, default: null },
  knownTags: { type: Array, default: () => [] },
  busy: Boolean,
  error: { type: String, default: '' },
})
const emit = defineEmits(['close', 'save'])

const form = reactive({
  name: '', host: '', port: 22, username: '', password: '',
  authType: 'password', privateKey: '', passphrase: '',
  note: '', tags: [], strictHostKey: true,
})
const newTag = ref('')
const tagSearch = ref('')
const localError = ref('')

const availableTags = computed(() => {
  const text = tagSearch.value.trim().toLowerCase()
  return props.knownTags.filter(tag =>
    !form.tags.some(selected => selected.toLowerCase() === tag.toLowerCase())
    && (!text || tag.toLowerCase().includes(text))
  )
})

watch(() => props.open, open => {
  if (!open) return
  const server = props.server
  Object.assign(form, {
    id: server?.id,
    name: server?.name || '',
    host: server?.host || '',
    port: server?.port || 22,
    username: server?.username || '',
    password: server?.password || '',
    authType: server?.authType === 'key' ? 'key' : 'password',
    privateKey: server?.privateKey || '',
    passphrase: server?.passphrase || '',
    note: server?.note || '',
    tags: [...(server?.tags || [])],
    strictHostKey: server?.strictHostKey !== false,
  })
  newTag.value = ''
  tagSearch.value = ''
  localError.value = ''
})

function toggleTag(tag) {
  const index = form.tags.findIndex(item => item.toLowerCase() === tag.toLowerCase())
  if (index >= 0) form.tags.splice(index, 1)
  else if (form.tags.length < 20) form.tags.push(tag)
}
function addTag() {
  const tag = newTag.value.trim().slice(0, 24)
  if (!tag) return
  if (!form.tags.some(item => item.toLowerCase() === tag.toLowerCase())) {
    if (form.tags.length >= 20) { localError.value = '最多 20 个标签'; return }
    form.tags.push(tag)
  }
  newTag.value = ''
  localError.value = ''
}
async function pickKeyFile() {
  try {
    const file = await window.shellDeck.dialog.pickKey()
    if (file) {
      form.privateKey = file.content
      localError.value = ''
    }
  } catch (error) {
    localError.value = error.message || '读取私钥失败'
  }
}
function submit() {
  if (form.authType === 'key' && !form.privateKey.trim()) {
    localError.value = '请填写私钥内容或选择私钥文件'
    return
  }
  localError.value = ''
  emit('save', {
    id: form.id,
    name: form.name,
    host: form.host,
    port: Number(form.port) || 22,
    username: form.username,
    password: form.password,
    authType: form.authType,
    privateKey: form.privateKey,
    passphrase: form.passphrase,
    note: form.note,
    tags: [...form.tags],
    strictHostKey: form.strictHostKey,
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="um-overlay">
      <section class="um-dialog sd-dialog" role="dialog" aria-modal="true">
        <button class="um-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
        <h2>{{ server ? '编辑服务器' : '新建服务器' }}</h2>
        <p class="sd-sub">密码、私钥明文保存在本机数据库，请妥善保管数据目录。</p>
        <div class="sd-form">
          <label class="sd-row"><span>名称</span><input v-model="form.name" maxlength="60" placeholder="例如：内网测试机" @keydown.enter.prevent="submit" /></label>
          <label class="sd-row"><span>主机</span><input v-model="form.host" maxlength="255" placeholder="IP 或域名" @keydown.enter.prevent="submit" /></label>
          <label class="sd-row"><span>端口</span><input v-model="form.port" type="number" min="1" max="65535" @keydown.enter.prevent="submit" /></label>
          <label class="sd-row"><span>账号</span><input v-model="form.username" maxlength="120" @keydown.enter.prevent="submit" /></label>
          <div class="sd-row">
            <span>认证方式</span>
            <div class="sd-auth">
              <button type="button" :class="{ active: form.authType === 'password' }" @click="form.authType = 'password'">密码</button>
              <button type="button" :class="{ active: form.authType === 'key' }" @click="form.authType = 'key'">密钥</button>
            </div>
          </div>
          <label v-if="form.authType === 'password'" class="sd-row"><span>密码</span><input v-model="form.password" type="text" autocomplete="off" @keydown.enter.prevent="submit" /></label>
          <template v-else>
            <div class="sd-row sd-row-top">
              <span>私钥</span>
              <div class="sd-keywrap">
                <textarea v-model="form.privateKey" class="sd-key" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
                <div class="sd-keyactions">
                  <button type="button" class="ssh-softbtn" @click="pickKeyFile">选择私钥文件</button>
                  <span>支持 OpenSSH / PEM 私钥</span>
                </div>
              </div>
            </div>
            <label class="sd-row"><span>私钥口令</span><input v-model="form.passphrase" type="password" autocomplete="off" placeholder="可留空" /></label>
            <label class="sd-row"><span>密码（sudo）</span><input v-model="form.password" type="text" autocomplete="off" placeholder="可留空" /></label>
          </template>
          <div class="sd-row sd-row-top">
            <span>标签</span>
            <div class="sd-tagwrap">
              <div v-if="form.tags.length" class="sd-tags sd-tags-selected">
                <button v-for="tag in form.tags" :key="tag" type="button" class="sd-tag active" @click="toggleTag(tag)">{{ tag }}</button>
              </div>
              <input v-model="tagSearch" class="sd-tagsearch" placeholder="搜索已有标签" />
              <div class="sd-taglist">
                <button v-for="tag in availableTags" :key="tag" type="button" class="sd-tag" @click="toggleTag(tag)">{{ tag }}</button>
                <span v-if="!availableTags.length" class="sd-tagempty">{{ knownTags.length ? '没有匹配的标签' : '暂无已有标签' }}</span>
              </div>
              <div class="sd-tagadd">
                <input v-model="newTag" maxlength="24" placeholder="新标签" @keydown.enter.prevent="addTag" />
                <button type="button" class="ssh-softbtn" @click="addTag">添加</button>
              </div>
            </div>
          </div>
          <label class="sd-row sd-row-top"><span>备注</span><textarea v-model="form.note" class="sd-note" maxlength="5000" rows="3" spellcheck="false"></textarea></label>
        </div>
        <div class="sd-row">
          <span>主机指纹</span>
          <label class="sd-checkbox"><input v-model="form.strictHostKey" type="checkbox" />严格校验</label>
        </div>
        <p v-if="localError || error" class="form-error">{{ localError || error }}</p>
        <div class="um-dialog-actions">
          <button type="button" @click="emit('close')">取消</button>
          <button type="button" class="um-primary" :disabled="busy" @click="submit">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
