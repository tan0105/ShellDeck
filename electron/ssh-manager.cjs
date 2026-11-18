const crypto = require('node:crypto')
const { Client } = require('ssh2')
const db = require('./db.cjs')

const sessions = new Map()

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

function close(sessionId, notify) {
  const session = sessions.get(String(sessionId))
  if (!session) return
  sessions.delete(String(sessionId))
  session.closing = true
  try { session.stream?.close() } catch { /* Already closed. */ }
  try { session.client.end() } catch { /* Already closed. */ }
  if (notify) send(session, 'terminal:closed', { sessionId: session.id })
}

function open(sender, { sessionId, server, cols = 80, rows = 24 }) {
  if (!sessionId || !server) throw new Error('终端会话参数不完整')
  close(sessionId, false)
  const id = String(sessionId)
  const client = new Client()
  const session = { id, client, sender, server, stream: null, closing: false, failed: false, hostKeyError: '' }
  sessions.set(id, session)

  const fail = message => {
    if (session.failed || session.closing) return
    session.failed = true
    send(session, 'terminal:error', { sessionId: id, message })
    close(id, false)
  }

  client.on('ready', () => {
    client.shell({ term: 'xterm-256color', cols: Math.max(2, Number(cols) || 80), rows: Math.max(2, Number(rows) || 24) }, (error, stream) => {
      if (error) { fail(humanError(error)); return }
      session.stream = stream
      stream.on('data', data => send(session, 'terminal:data', { sessionId: id, data }))
      stream.stderr.on('data', data => send(session, 'terminal:data', { sessionId: id, data }))
      stream.on('close', () => {
        if (session.closing) return
        session.closing = true
        send(session, 'terminal:closed', { sessionId: id })
        close(id, false)
      })
      stream.on('error', error => fail(humanError(error)))
      send(session, 'terminal:ready', { sessionId: id })
    })
  })

  client.on('error', error => {
    if (session.hostKeyError) fail(session.hostKeyError)
    else fail(humanError(error))
  })

  client.on('close', () => {
    if (session.closing) return
    session.closing = true
    if (session.stream) send(session, 'terminal:closed', { sessionId: id })
    else fail('连接已关闭')
    sessions.delete(id)
  })

  const host = String(server.host || '')
  const port = Number(server.port) || 22
  const strict = server.strictHostKey !== false

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
      hostVerifier: (key) => {
        if (!strict) return true
        const current = fingerprint(key)
        const recorded = db.getHostKey(host, port, 'ssh')
        if (!recorded) {
          db.saveHostKey(host, port, 'ssh', current)
          return true
        }
        if (recorded !== current) {
          session.hostKeyError = `主机指纹已变化，已阻止连接。\n原指纹：${recorded.slice(0, 23)}…\n新指纹：${current.slice(0, 23)}…\n如确认服务器重装过，请在服务器设置里关闭严格校验后再连接。`
          return false
        }
        return true
      },
    })
  } catch (error) {
    fail(humanError(error))
  }
}

function input(sessionId, data) {
  const session = sessions.get(String(sessionId))
  if (!session || !session.stream) return false
  session.stream.write(typeof data === 'string' ? data : Buffer.from(data))
  return true
}

function resize(sessionId, cols, rows) {
  const session = sessions.get(String(sessionId))
  if (!session || !session.stream) return false
  try {
    session.stream.setWindow(Math.max(2, Number(rows) || 24), Math.max(2, Number(cols) || 80), 0, 0)
    return true
  } catch {
    return false
  }
}

function closeAll() {
  for (const id of [...sessions.keys()]) close(id, false)
}

function activeCount() {
  return sessions.size
}

module.exports = { open, input, resize, close, closeAll, activeCount }
