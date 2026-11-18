const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, net } = require('electron')
const db = require('./db.cjs')

const APP_ID = 'com.shelldeck.desktop'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA67zvnWyUHWCHx1jEVGRo8fXDj3ZRE2X+QMKlBitkulg=
-----END PUBLIC KEY-----`

let paths = null
let emit = () => {}
let state = {
  status: 'idle',
  version: '',
  notes: '',
  progress: 0,
  error: '',
  source: '',
  checkedAt: '',
  asset: null,
}
let running = false

function init(options) {
  paths = options.paths
  emit = options.emit || emit
  state.checkedAt = db.getSetting('update.lastCheck') || ''
}

function snapshot() {
  return { ...state, currentVersion: app.getVersion() }
}

function setState(patch) {
  state = { ...state, ...patch }
  emit(snapshot())
  return snapshot()
}

function compareVersions(left, right) {
  const parse = value => String(value || '0').split('-')[0].split('.').map(part => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function httpGet(url, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) { reject(new Error('更新源必须使用 HTTPS')); return }
    let settled = false
    const done = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const request = net.request({ url, method: 'GET', redirect: 'follow' })
    const timer = setTimeout(() => {
      try { request.abort() } catch { /* already done */ }
      done(Object.assign(new Error('请求超时'), { transient: true }))
    }, 20000)
    request.on('response', response => {
      const chunks = []
      let total = 0
      response.on('data', chunk => {
        total += chunk.length
        if (total > maxBytes) {
          try { request.abort() } catch { /* already done */ }
          done(new Error('更新响应过大'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(timer)
        const buffer = Buffer.concat(chunks)
        if (response.statusCode >= 200 && response.statusCode < 300) done(null, buffer)
        else done(Object.assign(new Error(`HTTP ${response.statusCode}`), { status: response.statusCode }))
      })
      response.on('error', error => { clearTimeout(timer); done(Object.assign(error, { transient: true })) })
    })
    request.on('error', error => { clearTimeout(timer); done(Object.assign(error, { transient: true })) })
    request.end()
  })
}

function sourceManifestUrl(source) {
  const base = String(source.baseUrl || '').replace(/\/+$/, '')
  if (source.type === 'local') return path.join(source.baseUrl, 'release.json')
  if (base.endsWith('.json')) return base
  return base + '/release.json'
}

async function readSource(source) {
  const manifestUrl = sourceManifestUrl(source)
  let raw
  let signatureText
  if (source.type === 'local') {
    raw = fs.readFileSync(manifestUrl)
    signatureText = fs.readFileSync(manifestUrl + '.sig', 'utf8')
  } else {
    raw = await httpGet(manifestUrl)
    signatureText = (await httpGet(manifestUrl + '.sig', 64 * 1024)).toString('utf8')
  }
  const signature = Buffer.from(String(signatureText).replace(/\s+/g, ''), 'base64')
  if (!signature.length) throw new Error('更新清单缺少签名')
  const valid = crypto.verify(null, raw, PUBLIC_KEY, signature)
  if (!valid) throw new Error('更新清单签名校验失败')
  let manifest
  try { manifest = JSON.parse(raw.toString('utf8')) } catch { throw new Error('更新清单不是有效 JSON') }
  return { manifest, manifestUrl, raw }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('更新清单格式不正确')
  if (manifest.schemaVersion !== 1) throw new Error('更新清单版本不支持')
  if (manifest.appId !== APP_ID) throw new Error('更新清单 appId 不匹配')
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ''))) throw new Error('更新清单版本号不正确')
  const asset = manifest.assets && manifest.assets['win-x64']
  if (!asset || typeof asset !== 'object') throw new Error('更新清单缺少 Windows x64 资产')
  if (!/^[a-f0-9]{64}$/i.test(String(asset.sha256 || ''))) throw new Error('更新清单缺少有效的 SHA-256')
  if (!Number.isFinite(Number(asset.size)) || Number(asset.size) <= 0) throw new Error('更新清单资产大小不正确')
  return asset
}

function backoffSetting(id) {
  try { return JSON.parse(db.getSetting('update.backoff.' + id) || '{}') } catch { return {} }
}

function markBackoff(source, error) {
  const transient = error && (error.transient || [403, 429, 500, 502, 503, 504].includes(Number(error.status)))
  if (!transient) return
  const previous = backoffSetting(source.id)
  const level = Math.min(3, (Number(previous.level) || 0) + 1)
  const hours = [1, 6, 24][level - 1] || 24
  db.setSetting('update.backoff.' + source.id, JSON.stringify({ level, until: Date.now() + hours * 3600 * 1000 }))
}

function clearBackoff(id) {
  db.setSetting('update.backoff.' + id, '')
}

function inBackoff(source) {
  const value = backoffSetting(source.id)
  return Number(value.until || 0) > Date.now()
}

async function check({ manual = false } = {}) {
  if (running) return snapshot()
  const sources = db.listSources().filter(source => source.enabled)
  if (!sources.length) {
    if (manual) throw new Error('还没有配置更新源')
    return snapshot()
  }
  running = true
  setState({ status: 'checking', error: '', progress: 0, asset: null })
  const failures = []
  let upToDate = null
  try {
    for (const source of sources) {
      if (inBackoff(source)) continue
      try {
        const { manifest, manifestUrl } = await readSource(source)
        clearBackoff(source.id)
        const asset = validateManifest(manifest)
        const current = app.getVersion()
        if (manifest.minSupportedVersion && compareVersions(current, manifest.minSupportedVersion) < 0) {
          throw new Error(`当前版本过低，请手动下载 ${manifest.version} 完整安装包`)
        }
        if (compareVersions(manifest.version, current) <= 0) {
          upToDate = { version: manifest.version, source: source.name }
          continue
        }
        const url = source.type === 'local'
          ? path.resolve(path.dirname(manifestUrl), asset.url)
          : asset.url
        if (source.type !== 'local' && !/^https:\/\//i.test(String(url))) throw new Error('资产地址必须使用 HTTPS')
        db.setSetting('update.lastCheck', new Date().toISOString())
        setState({
          status: 'available',
          version: manifest.version,
          notes: String(manifest.notes || ''),
          source: source.name,
          checkedAt: new Date().toISOString(),
          progress: 0,
          error: '',
          asset: {
            url,
            size: Number(asset.size),
            sha256: String(asset.sha256).toLowerCase(),
            sourceId: source.id,
            sourceType: source.type,
          },
        })
        return snapshot()
      } catch (error) {
        markBackoff(source, error)
        failures.push(`${source.name}：${error.message}`)
      }
    }
    db.setSetting('update.lastCheck', new Date().toISOString())
    if (upToDate) {
      return setState({
        status: 'up-to-date',
        version: upToDate.version,
        source: upToDate.source,
        checkedAt: new Date().toISOString(),
        progress: 0,
        error: failures.join('\n'),
        asset: null,
      })
    }
    if (failures.length) throw new Error(failures.join('\n'))
    setState({ status: 'up-to-date', checkedAt: new Date().toISOString(), progress: 0, asset: null })
    return snapshot()
  } catch (error) {
    setState({ status: 'error', error: error.message || '检查更新失败', progress: 0 })
    if (manual) throw error
    return snapshot()
  } finally {
    running = false
  }
}

function download() {
  if (running) return snapshot()
  if (!state.asset) throw new Error('请先检查更新')
  const asset = state.asset
  const version = state.version
  running = true
  setState({ status: 'downloading', progress: 0, error: '' })

  return new Promise(resolve => {
    const targetDir = path.join(paths.updatesDir, version)
    fs.mkdirSync(targetDir, { recursive: true })
    const finalPath = path.join(targetDir, 'ShellDeck.exe')
    const partPath = finalPath + '.part'
    const fail = error => {
      running = false
      try { fs.unlinkSync(partPath) } catch { /* Not present. */ }
      setState({ status: 'error', error: '下载失败：' + (error.message || error), progress: 0 })
      resolve(snapshot())
    }
    const succeed = () => {
      running = false
      setState({ status: 'ready', progress: 100, asset: { ...asset, localPath: finalPath } })
      resolve(snapshot())
    }

    if (asset.sourceType === 'local' || !/^https:\/\//i.test(asset.url)) {
      try {
        const buffer = fs.readFileSync(asset.url)
        const hash = crypto.createHash('sha256').update(buffer).digest('hex')
        if (buffer.length !== asset.size) throw new Error('文件大小与清单不一致')
        if (hash !== asset.sha256) throw new Error('SHA-256 校验失败')
        fs.writeFileSync(finalPath, buffer)
        succeed()
      } catch (error) {
        fail(error)
      }
      return
    }

    const hash = crypto.createHash('sha256')
    let received = 0
    const file = fs.createWriteStream(partPath)
    const request = net.request({ url: asset.url, method: 'GET', redirect: 'follow' })
    const timer = setTimeout(() => {
      try { request.abort() } catch { /* already done */ }
      file.destroy()
      fail(new Error('下载超时'))
    }, 10 * 60 * 1000)
    request.on('response', response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        clearTimeout(timer)
        file.destroy()
        fail(new Error(`HTTP ${response.statusCode}`))
        return
      }
      response.on('data', chunk => {
        received += chunk.length
        hash.update(chunk)
        file.write(chunk)
        const progress = asset.size ? Math.min(99, Math.round(received / asset.size * 100)) : 0
        setState({ status: 'downloading', progress })
      })
      response.on('end', () => {
        clearTimeout(timer)
        file.end(() => {
          try {
            if (received !== asset.size) throw new Error('文件大小与清单不一致')
            if (hash.digest('hex') !== asset.sha256) throw new Error('SHA-256 校验失败')
            fs.renameSync(partPath, finalPath)
            succeed()
          } catch (error) {
            fail(error)
          }
        })
      })
      response.on('error', error => { clearTimeout(timer); file.destroy(); fail(error) })
    })
    request.on('error', error => { clearTimeout(timer); file.destroy(); fail(error) })
    request.end()
  })
}

function install() {
  if (state.status !== 'ready' || !state.asset || !state.asset.localPath) throw new Error('没有已下载的安装包')
  if (!app.isPackaged) throw new Error('开发模式下不执行替换安装')
  const rootDir = path.dirname(paths.dataDir)
  const launcher = path.join(rootDir, 'ShellDeck.exe')
  if (!process.env.PORTABLE_EXECUTABLE_FILE && fs.existsSync(launcher) && fs.existsSync(path.join(rootDir, 'runtime'))) {
    throw new Error('当前是文件夹版：请退出程序后，用新版本的 runtime 目录覆盖旧目录，data 目录保持不变')
  }
  const appExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  if (!fs.existsSync(appExe)) throw new Error('找不到当前程序文件')
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'update-helper.ps1')
    : path.join(__dirname, 'update-helper.ps1')
  const backup = path.join(path.dirname(appExe), 'ShellDeck.previous.exe')
  const logPath = path.join(paths.updatesDir, 'update.log')
  const { spawn } = require('node:child_process')
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-AppExe', appExe,
    '-NewExe', state.asset.localPath,
    '-Backup', backup,
    '-TargetPid', String(process.pid),
    '-ParentPid', String(portable ? process.ppid : 0),
    '-LogPath', logPath,
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  setState({ status: 'installing', progress: 100 })
  setTimeout(() => app.quit(), 400)
  return snapshot()
}

function listSources() {
  return db.listSources()
}

function addSource(input) {
  return db.saveSource(input)
}

function removeSource(id) {
  db.setSetting('update.backoff.' + id, '')
  return db.deleteSource(id)
}

module.exports = { init, snapshot, check, download, install, listSources, addSource, removeSource }
