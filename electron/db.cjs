const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')

const MAX_SERVERS = 50
const MAX_COMMANDS = 50

let db = null
let paths = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  password TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL DEFAULT 'password',
  private_key TEXT NOT NULL DEFAULT '',
  passphrase TEXT NOT NULL DEFAULT '',
  note TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  strict_host_key INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS update_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS host_keys (
  host TEXT,
  port INTEGER,
  key_type TEXT,
  fingerprint TEXT,
  PRIMARY KEY (host, port, key_type)
);
`

function now() {
  return new Date().toISOString()
}

function open(file) {
  const database = new Database(file)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.exec(SCHEMA)
  ensureServerColumns(database)
  database.pragma('user_version = 1')
  return database
}

function ensureServerColumns(database) {
  const columns = database.pragma('table_info(servers)').map(column => column.name)
  const additions = [
    ['auth_type', "TEXT NOT NULL DEFAULT 'password'"],
    ['private_key', "TEXT NOT NULL DEFAULT ''"],
    ['passphrase', "TEXT NOT NULL DEFAULT ''"],
  ]
  for (const [name, definition] of additions) {
    if (!columns.includes(name)) database.exec(`ALTER TABLE servers ADD COLUMN ${name} ${definition}`)
  }
}

function init(filePaths) {
  paths = filePaths
  fs.mkdirSync(paths.backupsDir, { recursive: true })
  db = open(paths.dbFile)
  return db
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(',')
  const result = []
  for (const raw of list) {
    const tag = String(raw || '').trim().slice(0, 24)
    if (!tag) continue
    if (result.some(item => item.toLowerCase() === tag.toLowerCase())) continue
    result.push(tag)
    if (result.length >= 20) break
  }
  return result
}

function mapServer(row) {
  if (!row) return null
  let tags = []
  try {
    const parsed = JSON.parse(row.tags_json || '[]')
    if (Array.isArray(parsed)) tags = parsed.map(String)
  } catch { /* Keep an empty tag list for malformed rows. */ }
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: Number(row.port) || 22,
    username: row.username,
    password: row.password || '',
    authType: row.auth_type === 'key' ? 'key' : 'password',
    privateKey: row.private_key || '',
    passphrase: row.passphrase || '',
    note: row.note || '',
    tags,
    strictHostKey: Boolean(row.strict_host_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function validateServer(input) {
  const name = String(input.name || '').trim()
  const host = String(input.host || '').trim()
  const username = String(input.username || '').trim()
  const port = Number(input.port) || 22
  if (!name) throw new Error('请填写服务器名称')
  if (!host) throw new Error('请填写主机地址')
  if (!username) throw new Error('请填写登录账号')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需在 1-65535 之间')
  if (name.length > 60) throw new Error('服务器名称最多 60 个字符')
  if (host.length > 255) throw new Error('主机地址最多 255 个字符')
  const authType = input.authType === 'key' ? 'key' : 'password'
  const privateKey = String(input.privateKey ?? '')
  if (authType === 'key' && !privateKey.trim()) throw new Error('请填写私钥内容')
  return {
    name,
    host,
    port,
    username: username.slice(0, 120),
    password: String(input.password ?? ''),
    authType,
    privateKey,
    passphrase: String(input.passphrase ?? ''),
    note: String(input.note || '').slice(0, 5000),
    tags: normalizeTags(input.tags),
    strictHostKey: input.strictHostKey === false ? 0 : 1,
  }
}

function listServers() {
  return getDb().prepare('SELECT * FROM servers ORDER BY created_at ASC, name ASC').all().map(mapServer)
}

function getServer(id) {
  return mapServer(getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id))
}

function saveServer(input) {
  const database = getDb()
  const data = validateServer(input || {})
  const stamp = now()
  let id = String(input.id || '')
  const existing = id ? database.prepare('SELECT id FROM servers WHERE id = ?').get(id) : null
  if (existing) {
    database.prepare(`UPDATE servers SET name=?, host=?, port=?, username=?, password=?, auth_type=?, private_key=?, passphrase=?, note=?, tags_json=?, strict_host_key=?, updated_at=? WHERE id=?`)
      .run(data.name, data.host, data.port, data.username, data.password, data.authType, data.privateKey, data.passphrase, data.note, JSON.stringify(data.tags), data.strictHostKey, stamp, id)
  } else {
    const count = database.prepare('SELECT COUNT(*) AS count FROM servers').get().count
    if (count >= MAX_SERVERS) throw new Error(`最多保存 ${MAX_SERVERS} 台服务器`)
    id = crypto.randomUUID()
    database.prepare(`INSERT INTO servers (id, name, host, port, username, password, auth_type, private_key, passphrase, note, tags_json, strict_host_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, data.name, data.host, data.port, data.username, data.password, data.authType, data.privateKey, data.passphrase, data.note, JSON.stringify(data.tags), data.strictHostKey, stamp, stamp)
  }
  return getServer(id)
}

function deleteServer(id) {
  getDb().prepare('DELETE FROM servers WHERE id = ?').run(id)
  return true
}

function importServers(rows) {
  if (!Array.isArray(rows)) throw new Error('导入数据格式不正确')
  const result = { added: 0, updated: 0, skipped: 0 }
  for (const row of rows) {
    try {
      const candidate = {
        id: String(row.id || row.ID || '').trim(),
        name: String(row.name || row['名称'] || '').trim(),
        host: String(row.host || row['主机'] || '').trim(),
        port: Number(row.port || row['端口'] || 22) || 22,
        username: String(row.username || row['账号'] || '').trim(),
        password: String(row.password ?? row['密码'] ?? ''),
        authType: String(row.authType || row['认证方式'] || '').includes('key') || String(row.authType || row['认证方式'] || '').includes('密钥') ? 'key' : 'password',
        privateKey: String(row.privateKey ?? row['私钥'] ?? ''),
        passphrase: String(row.passphrase ?? row['口令'] ?? ''),
        note: String(row.note || row['备注'] || ''),
        tags: String(row.tags || row['标签'] || ''),
        strictHostKey: true,
      }
      if (!candidate.name && !candidate.host) { result.skipped += 1; continue }
      const exists = candidate.id ? getDb().prepare('SELECT id FROM servers WHERE id = ?').get(candidate.id) : null
      const saved = saveServer(candidate)
      if (exists) result.updated += 1
      else if (saved) result.added += 1
    } catch (error) {
      if (String(error.message).includes('最多保存')) throw error
      result.skipped += 1
    }
  }
  return result
}

function mapCommand(row) {
  if (!row) return null
  return { id: row.id, name: row.name, kind: row.kind, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at }
}

function listCommands() {
  return getDb().prepare('SELECT * FROM commands ORDER BY created_at ASC, name ASC').all().map(mapCommand)
}

function saveCommand(input) {
  const database = getDb()
  const name = String(input.name || '').trim()
  const kind = input.kind === 'script' ? 'script' : 'command'
  const body = String(input.body ?? '')
  if (!name) throw new Error('请填写指令名称')
  if (!body.trim()) throw new Error('请填写指令内容')
  if (name.length > 60) throw new Error('指令名称最多 60 个字符')
  if (body.length > 20000) throw new Error('指令内容最多 20000 个字符')
  const stamp = now()
  let id = String(input.id || '')
  const existing = id ? database.prepare('SELECT id FROM commands WHERE id = ?').get(id) : null
  if (existing) {
    database.prepare('UPDATE commands SET name=?, kind=?, body=?, updated_at=? WHERE id=?').run(name, kind, body, stamp, id)
  } else {
    const count = database.prepare('SELECT COUNT(*) AS count FROM commands').get().count
    if (count >= MAX_COMMANDS) throw new Error(`最多保存 ${MAX_COMMANDS} 条指令`)
    id = crypto.randomUUID()
    database.prepare('INSERT INTO commands (id, name, kind, body, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, name, kind, body, stamp, stamp)
  }
  return mapCommand(database.prepare('SELECT * FROM commands WHERE id = ?').get(id))
}

function deleteCommand(id) {
  getDb().prepare('DELETE FROM commands WHERE id = ?').run(id)
  return true
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(String(key))
  return row ? row.value : null
}

function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(key), String(value))
  return true
}

function mapSource(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    priority: Number(row.priority) || 100,
    createdAt: row.created_at,
  }
}

function listSources() {
  return getDb().prepare('SELECT * FROM update_sources ORDER BY priority ASC, created_at ASC').all().map(mapSource)
}

function saveSource(input) {
  const database = getDb()
  const name = String(input.name || '').trim()
  const type = String(input.type || '').trim()
  const baseUrl = String(input.baseUrl || '').trim()
  if (!name) throw new Error('请填写更新源名称')
  if (!['github', 'static', 'agw', 'local'].includes(type)) throw new Error('更新源类型不支持')
  if (!baseUrl) throw new Error('请填写更新源地址')
  if (type !== 'local' && !/^https:\/\//i.test(baseUrl)) throw new Error('更新源必须使用 HTTPS')
  const id = String(input.id || '') || crypto.randomUUID()
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100
  const enabled = input.enabled === false ? 0 : 1
  database.prepare(`INSERT INTO update_sources (id, name, type, base_url, enabled, priority, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, base_url=excluded.base_url, enabled=excluded.enabled, priority=excluded.priority`)
    .run(id, name, type, baseUrl, enabled, priority, now())
  return mapSource(database.prepare('SELECT * FROM update_sources WHERE id = ?').get(id))
}

function deleteSource(id) {
  getDb().prepare('DELETE FROM update_sources WHERE id = ?').run(id)
  return true
}

function getHostKey(host, port, keyType) {
  const row = getDb().prepare('SELECT fingerprint FROM host_keys WHERE host = ? AND port = ? AND key_type = ?').get(host, port, keyType)
  return row ? row.fingerprint : null
}

function saveHostKey(host, port, keyType, fingerprint) {
  getDb().prepare('INSERT INTO host_keys (host, port, key_type, fingerprint) VALUES (?,?,?,?) ON CONFLICT(host, port, key_type) DO UPDATE SET fingerprint = excluded.fingerprint')
    .run(host, port, keyType, fingerprint)
}

function backupDatabase() {
  const database = getDb()
  fs.mkdirSync(paths.backupsDir, { recursive: true })
  database.pragma('wal_checkpoint(TRUNCATE)')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const target = path.join(paths.backupsDir, `ssh-${stamp}.db`)
  fs.copyFileSync(paths.dbFile, target)
  return target
}

function restoreDatabase(sourceFile) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('备份文件不存在')
  if (path.resolve(sourceFile) === path.resolve(paths.dbFile)) throw new Error('不能用当前数据库恢复自身')
  const database = getDb()
  database.pragma('wal_checkpoint(TRUNCATE)')
  fs.mkdirSync(paths.backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const preRestore = path.join(paths.backupsDir, `pre-restore-${stamp}.db`)
  fs.copyFileSync(paths.dbFile, preRestore)
  db.close()
  for (const suffix of ['-wal', '-shm']) {
    try { fs.unlinkSync(paths.dbFile + suffix) } catch { /* Not present. */ }
  }
  fs.copyFileSync(sourceFile, paths.dbFile)
  db = open(paths.dbFile)
  return { restoredFrom: sourceFile, previousSavedTo: preRestore }
}

function closeDatabase() {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* Closing anyway. */ }
    db.close()
    db = null
  }
}

module.exports = {
  init,
  getDb,
  closeDatabase,
  listServers,
  getServer,
  saveServer,
  deleteServer,
  importServers,
  listCommands,
  saveCommand,
  deleteCommand,
  getSetting,
  setSetting,
  listSources,
  saveSource,
  deleteSource,
  getHostKey,
  saveHostKey,
  backupDatabase,
  restoreDatabase,
}
