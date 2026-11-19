const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, net, session } = require('electron')
const db = require('./db.cjs')
const updateConfig = require('../shared/update-config.json')

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
  speed: 0,
  checkedAt: '',
  benchmark: [],
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

async function httpGet(url, maxBytes = 8 * 1024 * 1024, timeoutMs = 20000) {
  if (!/^https:\/\//i.test(url)) throw new Error('更新源必须使用 HTTPS')
  const netSession = await getUpdateSession()
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const options = { url, method: 'GET', redirect: 'follow' }
    if (netSession) options.session = netSession
    const request = net.request(options)
    const timer = setTimeout(() => {
      try { request.abort() } catch { /* already done */ }
      done(Object.assign(new Error('请求超时'), { transient: true }))
    }, timeoutMs)
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

function networkMode() {
  return String(db.getSetting('update.networkMode') || 'accelerator')
}

function normalizeProxy(value) {
  let text = String(value || '').trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text
  let parsed
  try { parsed = new URL(text) } catch { return null }
  const scheme = parsed.protocol.replace(':', '').toLowerCase()
  if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return null
  if (!parsed.hostname || !parsed.port) return null
  if (parsed.username || parsed.password) return null
  const defaultPort = scheme === 'http' ? '80' : scheme === 'https' ? '443' : '1080'
  return { authority: `${parsed.hostname}:${parsed.port || defaultPort}`, scheme }
}

let updateSession = null
let updateProxyRules = ''

async function getUpdateSession() {
  if (networkMode() !== 'proxy') return null
  const proxy = normalizeProxy(db.getSetting('update.proxy'))
  if (!proxy) throw new Error('请填写有效的自定义代理，例如 http://127.0.0.1:7890')
  const rules = proxy.scheme === 'http' || proxy.scheme === 'https'
    ? `http=${proxy.authority};https=${proxy.authority}`
    : `${proxy.scheme}=${proxy.authority}`
  if (!updateSession) updateSession = session.fromPartition('shelldeck-update-proxy')
  if (updateProxyRules !== rules) {
    await updateSession.setProxy({ proxyRules: rules })
    updateProxyRules = rules
  }
  return updateSession
}

async function readSource(source, timeoutMs = 20000) {
  const manifestUrl = sourceManifestUrl(source)
  let raw
  let signatureText
  if (source.type === 'local') {
    raw = fs.readFileSync(manifestUrl)
    signatureText = fs.readFileSync(manifestUrl + '.sig', 'utf8')
  } else {
    raw = await httpGet(manifestUrl, 8 * 1024 * 1024, timeoutMs)
    signatureText = (await httpGet(manifestUrl + '.sig', 64 * 1024, timeoutMs)).toString('utf8')
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
  const format = manifest.format === 'full' ? 'full' : 'asar'
  return { asset, format, electronVersion: String(manifest.electronVersion || '') }
}

function githubBaseUrl() {
  return `https://github.com/${updateConfig.githubRepo}/releases/latest/download`
}

function normalizePrefix(value) {
  const prefix = String(value || '').trim()
  if (!/^https:\/\//i.test(prefix)) return ''
  return prefix.endsWith('/') ? prefix : prefix + '/'
}

function githubSources() {
  const mode = String(db.getSetting('update.accelerator') || 'auto')
  const custom = normalizePrefix(db.getSetting('update.acceleratorCustom'))
  const direct = { id: 'github-direct', name: 'GitHub 直连', prefix: '' }
  const builtin = updateConfig.accelerators.map(item => ({ id: item.id, name: item.name, prefix: item.prefix }))
  let candidates
  if (mode === 'direct') candidates = [direct]
  else if (mode === 'custom') candidates = custom ? [{ id: 'github-custom', name: '自定义加速', prefix: custom }] : [direct, ...builtin]
  else if (mode === 'auto') candidates = [direct, ...builtin]
  else {
    const chosen = builtin.find(item => item.id === mode)
    candidates = chosen ? [chosen] : [direct, ...builtin]
  }
  const base = githubBaseUrl()
  return candidates.map(item => ({
    id: 'github:' + item.id,
    name: item.name,
    type: 'github',
    baseUrl: item.prefix ? item.prefix + base : base,
    proxyPrefix: item.prefix,
    enabled: true,
    priority: item.prefix ? 10 : -1,
  }))
}

function getSources() {
  if (networkMode() === 'proxy') {
    return [{ id: 'github:proxy', name: 'GitHub 代理', type: 'github', baseUrl: githubBaseUrl(), proxyPrefix: '', enabled: true, priority: 0 }]
  }
  const custom = db.listSources().filter(source => source.enabled && source.type !== 'github')
  return custom.length ? custom : githubSources()
}

function hasSources() {
  return true
}

async function probeDownloadSpeed(url, maxBytes = 256 * 1024, timeoutMs = 6000) {
  if (!/^https:\/\//i.test(url)) return { ok: false, bytes: 0, ms: 0, ttfb: 0, bps: 0, error: 'HTTPS required' }
  let netSession
  try { netSession = await getUpdateSession() } catch (error) { return { ok: false, bytes: 0, ms: 0, ttfb: 0, bps: 0, error: error.message } }
  return new Promise(resolve => {
    const started = Date.now()
    let received = 0
    let firstByte = 0
    let settled = false
    let request = null
    let timer = 0
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (request) request.abort() } catch { /* already done */ }
      const ms = Math.max(1, Date.now() - started)
      resolve({
        ok: !error && received >= maxBytes,
        bytes: received,
        ms,
        ttfb: firstByte ? firstByte - started : ms,
        bps: received ? Math.round(received * 1000 / ms) : 0,
        error: error ? error.message : '',
      })
    }
    const options = { url, method: 'GET', redirect: 'follow' }
    if (netSession) options.session = netSession
    request = net.request(options)
    try { request.setHeader('Range', `bytes=0-${maxBytes - 1}`) } catch { /* ignore */ }
    timer = setTimeout(() => finish(new Error('测速超时')), timeoutMs)
    request.on('response', response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish(new Error(`HTTP ${response.statusCode}`))
        return
      }
      response.on('data', chunk => {
        if (!firstByte) firstByte = Date.now()
        received += chunk.length
        if (received >= maxBytes) finish()
      })
      response.on('end', () => finish())
      response.on('error', error => finish(error))
    })
    request.on('error', error => finish(error))
    request.end()
  })
}

function buildCandidateList(rawUrl, sources) {
  return sources
    .filter(source => !inBackoff(source))
    .map(source => {
      if (source.type === 'local') return null
      let url = rawUrl
      if (source.proxyPrefix && /^https:\/\/github\.com\//i.test(url)) url = source.proxyPrefix + url
      if (!/^https:\/\//i.test(url)) return null
      return { url, name: source.name, id: source.id, type: source.type }
    })
    .filter(Boolean)
}

function networkFingerprint() {
  if (networkMode() === 'proxy') return 'proxy:' + String(db.getSetting('update.proxy') || '')
  return 'accelerator:' + String(db.getSetting('update.accelerator') || 'auto') + ':' + String(db.getSetting('update.acceleratorCustom') || '')
}

function cachedFastSource(candidates) {
  try {
    const cached = JSON.parse(db.getSetting('update.fastSource') || 'null')
    if (!cached || Date.now() - Number(cached.ts || 0) > 12 * 3600 * 1000) return null
    if (cached.fingerprint !== networkFingerprint()) return null
    const candidate = candidates.find(item => item.id === cached.id || (cached.name && item.name === cached.name))
    return candidate ? { ...candidate, speed: Number(cached.bps) || 0 } : null
  } catch {
    return null
  }
}

function rememberFastSource(chosen) {
  if (!chosen || !chosen.probe || !chosen.probe.ok || !chosen.probe.bps) return
  db.setSetting('update.fastSource', JSON.stringify({
    fingerprint: networkFingerprint(),
    id: chosen.id,
    name: chosen.name,
    bps: chosen.probe.bps,
    ts: Date.now(),
  }))
}

async function chooseFastestAsset(asset) {
  const candidates = (asset.candidates || []).filter(item => /^https:\/\//i.test(item.url))
  if (!candidates.length) return { url: asset.url, speed: 0, benchmarks: [] }
  if (candidates.length === 1) {
    return { url: candidates[0].url, name: candidates[0].name, id: candidates[0].id, type: candidates[0].type, speed: 0, benchmarks: [] }
  }
  const cached = cachedFastSource(candidates)
  if (cached) {
    return { url: cached.url, name: cached.name, id: cached.id, type: cached.type, speed: cached.speed, benchmarks: [] }
  }
  const firstPass = []
  for (const item of candidates) {
    firstPass.push({ ...item, probe: await probeDownloadSpeed(item.url, 128 * 1024, 3000) })
  }
  const sortProbe = (a, b) => (b.probe.bps - a.probe.bps) || (a.probe.ttfb - b.probe.ttfb) || (a.probe.ms - b.probe.ms)
  const validFirst = firstPass.filter(item => item.probe.ok).sort(sortProbe)
  const finalists = (validFirst.length ? validFirst : firstPass).slice(0, 2)
  const secondPass = []
  for (const item of finalists) {
    secondPass.push({ ...item, probe: await probeDownloadSpeed(item.url, 1024 * 1024, 6000) })
  }
  const validSecond = secondPass.filter(item => item.probe.ok).sort(sortProbe)
  const pool = validSecond.length ? validSecond : (validFirst.length ? validFirst : firstPass)
  const benchmarks = (validSecond.length ? validSecond : pool).map(item => ({
    name: item.name,
    ok: item.probe.ok,
    bps: item.probe.bps,
    ttfb: item.probe.ttfb,
    bytes: item.probe.bytes,
    error: item.probe.error,
  }))
  const chosen = validSecond[0] || validFirst[0] || firstPass.sort(sortProbe)[0] || candidates[0]
  rememberFastSource(chosen)
  return { url: chosen.url, name: chosen.name, id: chosen.id, type: chosen.type, speed: chosen.probe.bps || 0, benchmarks }
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
  const sources = getSources()
  if (!sources.length) {
    if (manual) throw new Error('还没有配置更新仓库')
    return snapshot()
  }
  running = true
  setState({ status: 'checking', error: '', progress: 0, asset: null, speed: 0, benchmark: [] })
  const failures = []
  let upToDate = null
  let available = null
  try {
    const current = app.getVersion()
    for (const source of sources) {
      if (inBackoff(source)) continue
      try {
        const { manifest, manifestUrl } = await readSource(source, 6000)
        clearBackoff(source.id)
        const { asset, format, electronVersion } = validateManifest(manifest)
        if (format === 'asar' && electronVersion && electronVersion !== process.versions.electron) {
          throw new Error(`此更新需要更新 Electron（${electronVersion}），请使用整包更新`)
        }
        if (manifest.minSupportedVersion && compareVersions(current, manifest.minSupportedVersion) < 0) {
          throw new Error(`当前版本过低，请手动下载 ${manifest.version} 完整安装包`)
        }
        if (compareVersions(manifest.version, current) <= 0) {
          if (!upToDate || compareVersions(manifest.version, upToDate.version) > 0) {
            upToDate = { version: manifest.version, source: source.name }
          }
          continue
        }
        let url = source.type === 'local'
          ? path.resolve(path.dirname(manifestUrl), asset.url)
          : String(asset.url)
        if (source.proxyPrefix && /^https:\/\/github\.com\//i.test(url)) url = source.proxyPrefix + url
        if (source.type !== 'local' && !/^https:\/\//i.test(url)) throw new Error('资产地址必须使用 HTTPS')
        available = { source, manifest, asset, format, electronVersion, url }
        break
      } catch (error) {
        markBackoff(source, error)
        failures.push(`${source.name}：${error.message}`)
      }
    }
    db.setSetting('update.lastCheck', new Date().toISOString())
    if (available) {
      const rawUrl = String(available.asset.url)
      return setState({
        status: 'available',
        version: available.manifest.version,
        notes: String(available.manifest.notes || ''),
        source: available.source.name,
        speed: 0,
        benchmark: [],
        checkedAt: new Date().toISOString(),
        progress: 0,
        error: '',
        asset: {
          url: available.url,
          size: Number(available.asset.size),
          sha256: String(available.asset.sha256).toLowerCase(),
          format: available.format,
          electronVersion: available.electronVersion,
          sourceId: available.source.id,
          sourceType: available.source.type,
          candidates: buildCandidateList(rawUrl, sources),
        },
      })
    }
    if (upToDate) {
      return setState({
        status: 'up-to-date',
        version: upToDate.version,
        source: upToDate.source,
        speed: 0,
        benchmark: [],
        checkedAt: new Date().toISOString(),
        progress: 0,
        error: failures.join('\n'),
        asset: null,
      })
    }
    if (failures.length) throw new Error(failures.join('\n'))
    return setState({ status: 'up-to-date', speed: 0, benchmark: [], checkedAt: new Date().toISOString(), progress: 0, asset: null })
  } catch (error) {
    setState({ status: 'error', speed: 0, benchmark: [], error: error.message || '检查更新失败', progress: 0 })
    if (manual) throw error
    return snapshot()
  } finally {
    running = false
  }
}

async function download() {
  if (running) return snapshot()
  if (!state.asset) throw new Error('请先检查更新')
  let asset = state.asset
  const version = state.version
  running = true

  if (asset.sourceType !== 'local' && Array.isArray(asset.candidates) && asset.candidates.length > 1) {
    setState({ status: 'testing', progress: 0, error: '' })
    try {
      const chosen = await chooseFastestAsset(asset)
      asset = {
        ...asset,
        url: chosen.url,
        sourceId: chosen.id || asset.sourceId,
        sourceType: chosen.type || asset.sourceType,
      }
      setState({
        status: 'downloading',
        source: chosen.name || state.source,
        speed: chosen.speed || 0,
        benchmark: chosen.benchmarks || [],
        asset,
        progress: 0,
        error: '',
      })
    } catch (error) {
      running = false
      db.setSetting('update.fastSource', '')
      setState({ status: 'error', error: '测速失败：' + (error.message || error), progress: 0 })
      return snapshot()
    }
  } else {
    setState({ status: 'downloading', progress: 0, error: '' })
  }

  let netSession = null
  if (asset.sourceType !== 'local' && /^https:\/\//i.test(asset.url)) {
    try {
      netSession = await getUpdateSession()
    } catch (error) {
      running = false
      setState({ status: 'error', error: '下载失败：' + error.message, progress: 0 })
      return snapshot()
    }
  }

  return new Promise(resolve => {
    const targetDir = path.join(paths.updatesDir, version)
    fs.mkdirSync(targetDir, { recursive: true })
    const finalPath = path.join(targetDir, asset.format === 'full' ? 'runtime.zip' : 'payload.bin')
    const partPath = finalPath + '.part'
    const fail = error => {
      running = false
      db.setSetting('update.fastSource', '')
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
    const options = { url: asset.url, method: 'GET', redirect: 'follow' }
    if (netSession) options.session = netSession
    const request = net.request(options)
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
  if (state.asset.format === 'full') throw new Error('整包更新暂不支持应用内安装，请手动替换 runtime')
  const runtimeDir = path.dirname(process.resourcesPath)
  const rootDir = path.dirname(runtimeDir)
  const launcher = path.join(rootDir, 'ShellDeck.exe')
  const targetAsar = path.join(process.resourcesPath, 'app.asar')
  if (!fs.existsSync(launcher) || !fs.existsSync(targetAsar)) {
    throw new Error('未找到文件夹版入口或 app.asar，无法自动安装')
  }
  const helper = app.isPackaged
    ? path.join(process.resourcesPath, 'update-helper.cjs')
    : path.join(__dirname, 'update-helper.cjs')
  const backup = targetAsar + '.previous'
  const logPath = path.join(paths.updatesDir, 'update.log')
  try { fs.rmSync(logPath, { force: true }) } catch { /* ignore */ }
  const { spawn } = require('node:child_process')
  const child = spawn(process.execPath, [
    helper,
    '--mode', 'asar',
    '--launcher', launcher,
    '--target-file', targetAsar,
    '--new-file', state.asset.localPath,
    '--backup-file', backup,
    '--target-pid', String(process.pid),
    '--log-path', logPath,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
  setState({ status: 'installing', progress: 100 })
  let waited = 0
  let settled = false
  let timer = 0
  const finishError = error => {
    if (settled) return
    settled = true
    clearInterval(timer)
    setState({ status: 'error', error: '安装更新失败：' + (error.message || error), progress: 0 })
  }
  timer = setInterval(() => {
    if (settled) return
    if (fs.existsSync(logPath)) {
      settled = true
      clearInterval(timer)
      setTimeout(() => app.quit(), 500)
      return
    }
    waited += 100
    if (waited >= 8000) finishError(new Error('更新进程未能启动，请重试'))
  }, 100)
  child.on('error', finishError)
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

module.exports = { init, snapshot, check, download, install, listSources, addSource, removeSource, hasSources }
