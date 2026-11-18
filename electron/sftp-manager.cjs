const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Client } = require('ssh2')
const db = require('./db.cjs')

const sessions = new Map()
const transfers = new Map()

function send(session, channel, payload) {
  if (!session.sender || session.sender.isDestroyed()) return
  session.sender.send(channel, payload)
}

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('hex')
}

function humanError(error) {
  const message = String(error && error.message ? error.message : error || '')
  if (/authentication/i.test(message) || error && error.level === 'client-authentication') return '认证失败：账号或密码不正确'
  if (/timed?\s*out/i.test(message) || error && error.level === 'client-timeout') return '连接超时，请检查主机地址和网络'
  if (/ECONNREFUSED/i.test(message)) return '连接被拒绝，请检查 SSH 端口是否开放'
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '无法解析主机地址'
  if (/EHOSTUNREACH|ENETUNREACH/i.test(message)) return '网络不可达'
  if (/ECONNRESET|EPIPE/i.test(message)) return '连接被远端重置'
  return message || '连接失败'
}

function humanFsError(error) {
  const message = String(error && error.message ? error.message : error || '')
  if (/permission denied|EACCES/i.test(message)) return '权限不足'
  if (/no such file|ENOENT/i.test(message)) return '路径不存在'
  if (/failure|EOF/i.test(message) && !message.trim()) return '远端 SFTP 操作失败'
  return message || '文件操作失败'
}

function pcall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, result) => {
      if (error) reject(new Error(humanFsError(error)))
      else resolve(result)
    })
  })
}

function normalizeRemote(input, fallback) {
  const value = String(input || fallback || '/').replace(/\\/g, '/')
  const normalized = path.posix.normalize(value.startsWith('/') ? value : '/' + value)
  return normalized || '/'
}

function joinRemote(base, name) {
  const root = normalizeRemote(base, '/')
  return root === '/' ? '/' + name : root + '/' + name
}

function modeIsDir(mode) {
  return (mode & 0o170000) === 0o040000
}
function modeIsLink(mode) {
  return (mode & 0o170000) === 0o120000
}

function modeText(mode) {
  const bits = Number(mode) || 0
  const chars = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']
  let text = modeIsDir(bits) ? 'd' : modeIsLink(bits) ? 'l' : '-'
  text += chars[(bits >> 6) & 7]
  text += chars[(bits >> 3) & 7]
  text += chars[bits & 7]
  return text
}

function mapEntry(name, attrs) {
  const mode = Number(attrs.mode) || 0
  const type = attrs.isDirectory() ? 'dir' : (attrs.isSymbolicLink?.() || modeIsLink(mode)) ? 'link' : modeIsDir(mode) ? 'dir' : 'file'
  return {
    name,
    type,
    size: attrs.size !== undefined ? Number(attrs.size) || 0 : 0,
    mtime: attrs.mtime ? Number(attrs.mtime) : 0,
    mode,
    perm: mode & 0o777,
    modeText: modeText(mode),
  }
}

function base64Path(remotePath) {
  return `"$(printf %s ${Buffer.from(remotePath, 'utf8').toString('base64')} | base64 -d)"`
}

function execRaw(client, command, input) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(new Error(humanError(error))); return }
      const stdout = []
      const stderr = []
      stream.on('data', chunk => stdout.push(chunk))
      stream.stderr.on('data', chunk => stderr.push(chunk))
      stream.on('error', reject)
      stream.on('close', code => {
        if (code === 0) resolve(Buffer.concat(stdout))
        else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `远端命令失败（退出码 ${code}）`))
      })
      if (input !== undefined && input !== null) stream.end(input)
      else stream.end()
    })
  })
}

async function ensureSudo(session) {
  if (session.sudoReady) return
  try {
    await execRaw(session.client, "sudo -S -p '' -v", String(session.server.password || '') + '\n')
    session.sudoReady = true
  } catch (error) {
    const detail = String(error.message || '').replace(/\r/g, '').trim()
    throw new Error('无法获取 sudo 权限：' + (detail || '请确认账号有 sudo 权限，且服务器清单里的密码正确'))
  }
}

async function runSudo(session, command, input) {
  await ensureSudo(session)
  try {
    return await execRaw(session.client, command, input)
  } catch (error) {
    if (/password is required|a terminal is required/i.test(String(error.message))) {
      session.sudoReady = false
      await ensureSudo(session)
      return execRaw(session.client, command, input)
    }
    throw error
  }
}

async function sudoScript(session, script) {
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return runSudo(session, `printf %s ${encoded} | base64 -d | sudo -n sh`)
}

async function getHome(session) {
  if (session.sudo) {
    const out = await runSudo(session, `sudo -n sh -c 'echo $HOME'`)
    const home = out.toString('utf8').trim()
    return home.startsWith('/') ? home : '/root'
  }
  try {
    const real = await pcall(session.sftp, 'realpath', '.')
    return normalizeRemote(real, '/')
  } catch {
    return '/'
  }
}

async function connect(sender, { sessionId, server, sudo = false }) {
  if (!sessionId || !server) throw new Error('文件会话参数不完整')
  close(sessionId)
  const id = String(sessionId)
  const client = new Client()
  const session = { id, client, sender, server, sudo: Boolean(sudo), sftp: null, sudoReady: false, home: '/', closing: false }
  sessions.set(id, session)

  const host = String(server.host || '')
  const port = Number(server.port) || 22
  const strict = server.strictHostKey !== false
  let hostKeyError = ''

  const ready = new Promise((resolve, reject) => {
    client.on('ready', resolve)
    client.on('error', error => {
      if (hostKeyError) reject(new Error(hostKeyError))
      else reject(new Error(humanError(error)))
    })
    client.on('close', () => {
      if (!session.closing) reject(new Error('连接已关闭'))
    })
  })

  try {
    const credentials = server.authType === 'key' && server.privateKey
      ? { privateKey: server.privateKey, ...(server.passphrase ? { passphrase: server.passphrase } : {}) }
      : { password: server.password }
    client.connect({
      host,
      port,
      username: server.username,
      ...credentials,
      readyTimeout: 15000,
      keepaliveInterval: 20000,
      keepaliveCountMax: 3,
      hostVerifier: key => {
        if (!strict) return true
        const current = fingerprint(key)
        const recorded = db.getHostKey(host, port, 'ssh')
        if (!recorded) { db.saveHostKey(host, port, 'ssh', current); return true }
        if (recorded !== current) {
          hostKeyError = `主机指纹已变化，已阻止连接。\n原指纹：${recorded.slice(0, 23)}…\n新指纹：${current.slice(0, 23)}…\n如确认服务器重装过，请在服务器设置里关闭严格校验后再连接。`
          return false
        }
        return true
      },
    })
    await ready
    session.sftp = await new Promise((resolve, reject) => {
      client.sftp((error, sftp) => error ? reject(new Error(humanError(error))) : resolve(sftp))
    })
    session.sftp.on('close', () => {
      if (!session.closing) close(id)
    })
    if (session.sudo) await ensureSudo(session)
    session.home = await getHome(session)
    return { sessionId: id, home: session.home, sudo: session.sudo }
  } catch (error) {
    close(id)
    throw new Error(humanError(error))
  }
}

function close(sessionId) {
  const id = String(sessionId || '')
  const session = sessions.get(id)
  for (const transfer of transfers.values()) {
    if (transfer.sessionId === id) cancelTransfer(transfer.id)
  }
  if (!session) return false
  sessions.delete(id)
  session.closing = true
  try { session.sftp?.end() } catch { /* Already closed. */ }
  try { session.client.end() } catch { /* Already closed. */ }
  return true
}

async function list(sessionId, target) {
  const session = getSession(sessionId)
  const remotePath = normalizeRemote(target, session.home)
  if (session.sudo) {
    const script = `p=$(printf %s ${Buffer.from(remotePath, 'utf8').toString('base64')} | base64 -d)
find "$p" -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%T@\\t%m\\n' 2>/dev/null
stat -c '%a' -- "$p" 2>/dev/null`
    const out = await sudoScript(session, script)
    const lines = out.toString('utf8').split('\n').filter(Boolean)
    let perm = 0
    const entries = []
    for (const line of lines) {
      const parts = line.split('\t')
      if (parts.length < 5) {
        if (/^[0-7]{3,4}$/.test(line.trim())) perm = parseInt(line.trim(), 8) & 0o777
        continue
      }
      const [name, typeChar, size, mtime, modeStr] = parts
      if (!name || name === '.' || name === '..') continue
      const mode = parseInt(modeStr, 8) & 0o7777
      const type = typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'link' : 'file'
      entries.push({
        name,
        type,
        size: Number(size) || 0,
        mtime: Math.round(Number(mtime) || 0),
        mode: type === 'dir' ? mode | 0o040000 : type === 'link' ? mode | 0o120000 : mode,
        perm: mode & 0o777,
        modeText: modeText(type === 'dir' ? mode | 0o040000 : mode),
      })
    }
    return { path: remotePath, perm: perm || null, entries }
  }
  let entries = []
  try {
    entries = await pcall(session.sftp, 'readdir', remotePath)
  } catch (error) {
    throw new Error(`读取目录失败：${error.message}`)
  }
  let perm = null
  try {
    const stat = await pcall(session.sftp, 'stat', remotePath)
    perm = Number(stat.mode) & 0o777
  } catch { /* Directory mode is optional metadata. */ }
  return {
    path: remotePath,
    perm,
    entries: entries.map(item => mapEntry(item.filename, item.attrs)),
  }
}

function getSession(sessionId) {
  const session = sessions.get(String(sessionId || ''))
  if (!session) throw new Error('文件会话已断开，请重新打开')
  return session
}

async function read(sessionId, target) {
  const session = getSession(sessionId)
  const remotePath = normalizeRemote(target)
  const MAX = 2 * 1024 * 1024
  let buffer
  if (session.sudo) {
    const statOut = await runSudo(session, `sudo -n stat -c '%s' -- ${base64Path(remotePath)}`)
    const size = Number(statOut.toString('utf8').trim()) || 0
    if (size > MAX) throw new Error('文件超过 2 MB，不能在线编辑，请下载后处理')
    buffer = await runSudo(session, `sudo -n cat -- ${base64Path(remotePath)}`)
  } else {
    const stat = await pcall(session.sftp, 'stat', remotePath)
    if (Number(stat.size) > MAX) throw new Error('文件超过 2 MB，不能在线编辑，请下载后处理')
    buffer = await pcall(session.sftp, 'readFile', remotePath)
  }
  if (buffer.includes(0)) throw new Error('检测到二进制内容，不能在线编辑，请下载后处理')
  return buffer.toString('utf8')
}

async function write(sessionId, target, content) {
  const session = getSession(sessionId)
  const remotePath = normalizeRemote(target)
  const buffer = Buffer.from(String(content ?? ''), 'utf8')
  if (buffer.length > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，不能在线保存')
  if (session.sudo) {
    await runSudo(session, `sudo -n tee -- ${base64Path(remotePath)} > /dev/null`, buffer)
  } else {
    await pcall(session.sftp, 'writeFile', remotePath, buffer)
  }
  return true
}

async function copyRemoteTree(sftp, source, target) {
  const stat = await pcall(sftp, 'lstat', source)
  if (stat.isSymbolicLink()) throw new Error('暂不支持复制符号链接')
  if (stat.isDirectory()) {
    try { await pcall(sftp, 'mkdir', target, { mode: stat.mode & 0o777 }) } catch { /* Merge into existing directory. */ }
    const entries = await pcall(sftp, 'readdir', source)
    for (const item of entries) {
      await copyRemoteTree(sftp, joinRemote(source, item.filename), joinRemote(target, item.filename))
    }
    return
  }
  await new Promise((resolve, reject) => {
    const reader = sftp.createReadStream(source)
    const writer = sftp.createWriteStream(target, { mode: stat.mode & 0o777 })
    reader.on('error', error => reject(new Error(humanFsError(error))))
    writer.on('error', error => reject(new Error(humanFsError(error))))
    writer.on('close', resolve)
    reader.pipe(writer)
  })
}

async function copy(sessionId, from, to, overwrite) {
  const session = getSession(sessionId)
  const source = normalizeRemote(from)
  const target = normalizeRemote(to)
  if (source === target) throw new Error('源和目标相同')
  if (await pathExists(session, target)) {
    if (!overwrite) throw new Error('目标已存在')
    await remove(sessionId, target, true)
  }
  if (session.sudo) {
    await runSudo(session, `sudo -n cp -a -- ${base64Path(source)} ${base64Path(target)}`)
  } else {
    await copyRemoteTree(session.sftp, source, target)
  }
  return true
}

async function move(sessionId, from, to, overwrite) {
  const session = getSession(sessionId)
  const source = normalizeRemote(from)
  const target = normalizeRemote(to)
  if (source === target) throw new Error('源和目标相同')
  if (await pathExists(session, target)) {
    if (!overwrite) throw new Error('目标已存在')
    await remove(sessionId, target, true)
  }
  if (session.sudo) {
    await runSudo(session, `sudo -n mv -f -- ${base64Path(source)} ${base64Path(target)}`)
    return true
  }
  try {
    await pcall(session.sftp, 'rename', source, target)
  } catch {
    await copyRemoteTree(session.sftp, source, target)
    await remove(sessionId, source, true)
  }
  return true
}

async function mkdir(sessionId, target) {
  const session = getSession(sessionId)
  const remotePath = normalizeRemote(target)
  if (session.sudo) {
    await runSudo(session, `sudo -n mkdir -p -- ${base64Path(remotePath)}`)
    return true
  }
  await pcall(session.sftp, 'mkdir', remotePath)
  return true
}

async function rename(sessionId, from, to) {
  const session = getSession(sessionId)
  const source = normalizeRemote(from)
  const target = normalizeRemote(to)
  if (session.sudo) {
    await runSudo(session, `sudo -n mv -- ${base64Path(source)} ${base64Path(target)}`)
  } else {
    await pcall(session.sftp, 'rename', source, target)
  }
  return true
}

async function removeTree(sftp, remotePath, isDir) {
  if (!isDir) {
    await pcall(sftp, 'unlink', remotePath)
    return
  }
  const entries = await pcall(sftp, 'readdir', remotePath)
  for (const item of entries) {
    const child = joinRemote(remotePath, item.filename)
    const dir = item.attrs.isDirectory() && !item.attrs.isSymbolicLink()
    await removeTree(sftp, child, dir)
  }
  await pcall(sftp, 'rmdir', remotePath)
}

async function remove(sessionId, target, recursive) {
  const session = getSession(sessionId)
  const remotePath = normalizeRemote(target)
  if (session.sudo) {
    await runSudo(session, `sudo -n rm -rf -- ${base64Path(remotePath)}`)
    return true
  }
  const stat = await pcall(session.sftp, 'lstat', remotePath)
  const isDir = stat.isDirectory() && !stat.isSymbolicLink()
  if (isDir && recursive) await removeTree(session.sftp, remotePath, true)
  else if (isDir) await pcall(session.sftp, 'rmdir', remotePath)
  else await pcall(session.sftp, 'unlink', remotePath)
  return true
}

async function chmodTree(sftp, remotePath, mode, recursive) {
  await pcall(sftp, 'chmod', remotePath, mode)
  if (!recursive) return 1
  const stat = await pcall(sftp, 'lstat', remotePath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 1
  let count = 1
  const entries = await pcall(sftp, 'readdir', remotePath)
  for (const item of entries) {
    count += await chmodTree(sftp, joinRemote(remotePath, item.filename), mode, true)
  }
  return count
}

async function chmod(sessionId, target, mode, recursive) {
  const session = getSession(sessionId)
  const remotePath = normalizeRemote(target)
  const value = Number(mode)
  if (!Number.isInteger(value) || value < 0 || value > 0o7777) throw new Error('权限值不正确')
  if (session.sudo) {
    await runSudo(session, `sudo -n chmod ${recursive ? '-R ' : ''}${value.toString(8)} -- ${base64Path(remotePath)}`)
    return { count: recursive ? -1 : 1 }
  }
  const count = await chmodTree(session.sftp, remotePath, value, Boolean(recursive))
  return { count }
}

function walkLocal(localPath, relative, files, dirs) {
  const stat = fs.lstatSync(localPath)
  if (stat.isSymbolicLink()) {
    const real = fs.statSync(localPath)
    if (real.isDirectory()) return
    files.push({ localPath, relative, size: real.size })
    return
  }
  if (stat.isDirectory()) {
    dirs.push(relative)
    for (const name of fs.readdirSync(localPath)) {
      walkLocal(path.join(localPath, name), relative ? relative + '/' + name : name, files, dirs)
    }
    return
  }
  if (stat.isFile()) files.push({ localPath, relative, size: stat.size })
}

function inspectLocal(paths) {
  const files = []
  const dirs = []
  const skipped = []
  for (const localPath of paths || []) {
    try {
      const name = path.basename(localPath)
      if (!name) continue
      walkLocal(localPath, name, files, dirs)
    } catch (error) {
      skipped.push({ path: localPath, reason: error.message })
    }
  }
  return {
    files,
    dirs: [...new Set(dirs)],
    skipped,
    totalBytes: files.reduce((sum, item) => sum + item.size, 0),
  }
}

async function pathExists(session, remotePath) {
  if (session.sudo) {
    try {
      await runSudo(session, `sudo -n stat -c '%s' -- ${base64Path(remotePath)}`)
      return true
    } catch {
      return false
    }
  }
  try {
    await pcall(session.sftp, 'lstat', remotePath)
    return true
  } catch {
    return false
  }
}

async function statMany(sessionId, targetDir, relativePaths) {
  const session = getSession(sessionId)
  const existing = []
  for (const relative of relativePaths || []) {
    const remotePath = joinRemote(targetDir, String(relative).replace(/\\/g, '/'))
    if (await pathExists(session, remotePath)) existing.push(relative)
  }
  return existing
}

function makeTransfer(sender, options) {
  const transfer = {
    ...options,
    sender,
    startedAt: Date.now(),
    lastAt: Date.now(),
    lastBytes: 0,
    speed: 0,
    cancelled: false,
    source: null,
    dest: null,
    timer: null,
  }
  transfers.set(transfer.id, transfer)
  transfer.timer = setInterval(() => reportTransfer(transfer, false), 350)
  if (transfer.timer.unref) transfer.timer.unref()
  return transfer
}

function transferPayload(transfer) {
  const elapsed = Math.max(0.001, (Date.now() - transfer.startedAt) / 1000)
  const percent = transfer.total > 0 ? Math.min(100, (transfer.transferred / transfer.total) * 100) : transfer.done ? 100 : 0
  const remaining = Math.max(0, transfer.total - transfer.transferred)
  const eta = transfer.speed > 1 ? remaining / transfer.speed : null
  return {
    sessionId: transfer.sessionId,
    transferId: transfer.id,
    kind: transfer.kind,
    label: transfer.label,
    fileIndex: transfer.fileIndex,
    fileCount: transfer.fileCount,
    fileTransferred: transfer.fileTransferred,
    fileTotal: transfer.fileTotal,
    transferred: transfer.transferred,
    total: transfer.total,
    percent: Math.round(percent),
    bytesPerSecond: Math.round(transfer.speed || (transfer.transferred / elapsed)),
    eta: eta === null ? null : Math.round(eta),
    done: Boolean(transfer.done),
  }
}

function reportTransfer(transfer, force) {
  if (!transfer.sender || transfer.sender.isDestroyed()) return
  const now = Date.now()
  const deltaTime = (now - transfer.lastAt) / 1000
  if (deltaTime >= 0.2) {
    const deltaBytes = transfer.transferred - transfer.lastBytes
    const instant = deltaBytes / deltaTime
    transfer.speed = transfer.speed ? transfer.speed * 0.65 + instant * 0.35 : instant
    transfer.lastAt = now
    transfer.lastBytes = transfer.transferred
  }
  if (force || now - (transfer.lastEmit || 0) >= 250) {
    transfer.lastEmit = now
    send({ sender: transfer.sender }, 'transfer:progress', transferPayload(transfer))
  }
}

function finishTransfer(transfer, channel, payload) {
  transfer.done = true
  if (transfer.timer) clearInterval(transfer.timer)
  transfer.timer = null
  if (transfer.source) { try { transfer.source.destroy() } catch { /* done */ } }
  if (transfer.dest) { try { transfer.dest.destroy() } catch { /* done */ } }
  transfer.source = null
  transfer.dest = null
  reportTransfer(transfer, true)
  if (transfer.sender && !transfer.sender.isDestroyed()) transfer.sender.send(channel, { ...transferPayload(transfer), ...payload })
  transfers.delete(transfer.id)
}

function cancelTransfer(transferId) {
  const transfer = transfers.get(String(transferId))
  if (!transfer) return false
  transfer.cancelled = true
  if (transfer.source) { try { transfer.source.destroy() } catch { /* already gone */ } }
  if (transfer.dest) { try { transfer.dest.destroy() } catch { /* already gone */ } }
  return true
}

function copyTracked(source, dest, transfer, onChunk) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = error => {
      if (settled) return
      settled = true
      transfer.source = null
      transfer.dest = null
      if (error) reject(error)
      else resolve()
    }
    transfer.source = source
    transfer.dest = dest
    source.on('data', chunk => {
      if (transfer.cancelled) return
      transfer.transferred += chunk.length
      transfer.fileTransferred += chunk.length
      onChunk?.(chunk.length)
      reportTransfer(transfer, false)
      if (transfer.transferred >= transfer.total) reportTransfer(transfer, true)
    })
    source.on('error', error => done(new Error(humanFsError(error))))
    dest.on('error', error => done(new Error(humanFsError(error))))
    dest.on('close', () => done())
    source.pipe(dest)
  })
}

function waitExecClose(stream, stderrChunks) {
  return new Promise((resolve, reject) => {
    stream.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(Buffer.concat(stderrChunks || []).toString('utf8').trim() || `远端命令失败（退出码 ${code}）`))
    })
    stream.on('error', error => reject(new Error(humanError(error))))
  })
}

async function ensureRemoteDir(session, remotePath) {
  if (session.sudo) {
    await runSudo(session, `sudo -n mkdir -p -- ${base64Path(remotePath)}`)
  } else {
    try { await pcall(session.sftp, 'mkdir', remotePath) } catch { /* Existing folders are fine. */ }
  }
}

async function upload(sender, { sessionId, transferId, targetDir, files, dirs, overwrite = false }) {
  const session = getSession(sessionId)
  const list = Array.isArray(files) ? files : []
  const folders = [...new Set(Array.isArray(dirs) ? dirs : [])].sort((a, b) => a.split('/').length - b.split('/').length)
  const total = list.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
  const transfer = makeTransfer(sender, {
    id: String(transferId), sessionId: String(sessionId), kind: 'upload', label: '准备上传…',
    transferred: 0, total, fileTransferred: 0, fileTotal: 0, fileIndex: 0, fileCount: list.length,
  })
  try {
    for (let index = 0; index < folders.length; index += 1) {
      if (transfer.cancelled) throw new Error('上传已取消')
      const folder = folders[index]
      transfer.label = `正在创建目录 ${index + 1}/${folders.length}：${folder}`
      reportTransfer(transfer, true)
      await ensureRemoteDir(session, joinRemote(targetDir, folder))
    }
    for (let index = 0; index < list.length; index += 1) {
      if (transfer.cancelled) throw new Error('上传已取消')
      const item = list[index]
      const remotePath = joinRemote(targetDir, String(item.relative).replace(/\\/g, '/'))
      transfer.fileIndex = index + 1
      transfer.fileTransferred = 0
      transfer.fileTotal = Number(item.size) || 0
      transfer.label = `正在上传 ${index + 1}/${list.length}：${item.relative}`
      reportTransfer(transfer, true)
      if (!overwrite && await pathExists(session, remotePath)) continue
      if (session.sudo) {
        const stream = await new Promise((resolve, reject) => {
          session.client.exec(`sudo -n tee -- ${base64Path(remotePath)} > /dev/null`, (error, result) => {
            if (error) reject(new Error(humanError(error)))
            else resolve(result)
          })
        })
        const stderrChunks = []
        stream.stderr.on('data', chunk => stderrChunks.push(chunk))
        const finished = waitExecClose(stream, stderrChunks)
        finished.catch(() => {})
        const source = fs.createReadStream(item.localPath)
        await copyTracked(source, stream.stdin, transfer)
        await finished
      } else {
        const source = fs.createReadStream(item.localPath)
        const dest = session.sftp.createWriteStream(remotePath)
        await copyTracked(source, dest, transfer)
      }
      if (transfer.cancelled) throw new Error('上传已取消')
    }
    transfer.transferred = transfer.total
    finishTransfer(transfer, 'transfer:done', { label: '上传完成' })
    return { transferId: transfer.id, files: list.length, dirs: folders.length }
  } catch (error) {
    const message = transfer.cancelled ? '上传已取消' : humanFsError(error)
    finishTransfer(transfer, 'transfer:error', { message })
    throw new Error(message)
  }
}

async function download(sender, { sessionId, transferId, remotePath, savePath }) {
  const session = getSession(sessionId)
  const remote = normalizeRemote(remotePath)
  let size = 0
  if (session.sudo) {
    const statOut = await runSudo(session, `sudo -n stat -c '%s' -- ${base64Path(remote)}`)
    size = Number(statOut.toString('utf8').trim()) || 0
  } else {
    const stat = await pcall(session.sftp, 'stat', remote)
    size = Number(stat.size) || 0
  }
  const transfer = makeTransfer(sender, {
    id: String(transferId), sessionId: String(sessionId), kind: 'download',
    label: `正在下载：${path.basename(remote)}`,
    transferred: 0, total: size, fileTransferred: 0, fileTotal: size, fileIndex: 1, fileCount: 1,
  })
  let dest
  try {
    fs.mkdirSync(path.dirname(savePath), { recursive: true })
    dest = fs.createWriteStream(savePath)
    if (session.sudo) {
      const stream = await new Promise((resolve, reject) => {
        session.client.exec(`sudo -n cat -- ${base64Path(remote)}`, (error, result) => {
          if (error) reject(new Error(humanError(error)))
          else resolve(result)
        })
      })
      const errors = []
      stream.stderr.on('data', chunk => errors.push(chunk))
      const finished = waitExecClose(stream, errors)
      finished.catch(() => {})
      await copyTracked(stream, dest, transfer)
      await finished
    } else {
      const source = session.sftp.createReadStream(remote)
      await copyTracked(source, dest, transfer)
    }
    if (transfer.cancelled) throw new Error('下载已取消')
    finishTransfer(transfer, 'transfer:done', { label: '下载完成', savePath })
    return { transferId: transfer.id, savePath, size }
  } catch (error) {
    const message = transfer.cancelled ? '下载已取消' : humanFsError(error)
    finishTransfer(transfer, 'transfer:error', { message })
    throw new Error(message)
  }
}

function activeTransferCount() {
  return transfers.size
}

function closeAll() {
  for (const id of [...sessions.keys()]) close(id)
  for (const id of [...transfers.keys()]) cancelTransfer(id)
}

module.exports = {
  connect,
  close,
  list,
  read,
  write,
  copy,
  move,
  mkdir,
  rename,
  remove,
  chmod,
  inspectLocal,
  statMany,
  upload,
  download,
  cancelTransfer,
  activeTransferCount,
  closeAll,
}
