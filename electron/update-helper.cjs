process.noAsar = true
let fs
try {
  fs = require('original-fs')
} catch {
  fs = require('node:fs')
}
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

function arg(name) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? String(process.argv[index + 1] || '') : ''
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const mode = arg('mode') === 'asar' ? 'asar' : 'exe'
const target = mode === 'asar' ? arg('target-file') : arg('app-exe')
const incoming = mode === 'asar' ? arg('new-file') : arg('new-exe')
const backupPath = mode === 'asar' ? arg('backup-file') : arg('backup')
const startExe = mode === 'asar' ? arg('launcher') : target
const targetPid = Number(arg('target-pid')) || 0
const logPath = arg('log-path')
const dataDirArg = arg('data-dir')
const userDataDir = arg('user-data-dir')
const runtimeArg = arg('runtime-exe')
const startMarker = arg('start-marker')
const derivedRuntime = mode === 'asar' && target
  ? path.join(path.dirname(path.dirname(target)), 'ShellDeckRuntime.exe')
  : (mode === 'exe' ? target : '')
const runtimeExe = runtimeArg || derivedRuntime
const verifiedStart = runtimeExe && fs.existsSync(runtimeExe) ? runtimeExe : ''
const startTarget = verifiedStart || startExe
const runtimeDir = verifiedStart ? path.dirname(verifiedStart) : ''
const dataDir = dataDirArg || (runtimeDir
  ? (mode === 'asar' ? path.join(path.dirname(runtimeDir), 'data') : path.join(runtimeDir, 'data'))
  : '')
const rootDir = dataDir ? path.dirname(dataDir) : (runtimeDir && mode === 'asar' ? path.dirname(runtimeDir) : runtimeDir)

function log(message) {
  if (!logPath) return
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `[${new Date().toLocaleString('zh-CN')}] ${message}\r\n`, 'utf8')
  } catch {
    // The helper still attempts the update if logging is unavailable.
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function inPlaceCopy(source, destination) {
  const input = fs.openSync(source, 'r')
  const output = fs.openSync(destination, 'r+')
  try {
    fs.ftruncateSync(output, 0)
    const buffer = Buffer.alloc(64 * 1024)
    let offset = 0
    for (;;) {
      const read = fs.readSync(input, buffer, 0, buffer.length, offset)
      if (!read) break
      fs.writeSync(output, buffer, 0, read, offset)
      offset += read
    }
    fs.fsyncSync(output)
  } finally {
    fs.closeSync(input)
    fs.closeSync(output)
  }
}
async function replaceFile(source, destination) {
  let lastError = null
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      fs.copyFileSync(source, destination)
      return
    } catch (error) {
      lastError = error
      await sleep(300)
    }
  }
  try {
    inPlaceCopy(source, destination)
  } catch {
    throw lastError || new Error('替换文件失败')
  }
}
function start(file, useMarker = false) {
  return new Promise((resolve, reject) => {
    let settled = false
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    if (dataDir) env.SHELLDECK_DATA_DIR = dataDir
    if (rootDir) env.PORTABLE_EXECUTABLE_DIR = rootDir
    const args = []
    if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)
    if (useMarker && startMarker) args.push(`--update-start-marker=${startMarker}`)
    const child = spawn(file, args, {
      cwd: path.dirname(file),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve(child)
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

async function startVerified(label, useMarker = false) {
  if (!verifiedStart) {
    await start(startTarget, useMarker)
    return
  }
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let child = null
    try {
      if (useMarker && startMarker) {
        try { fs.rmSync(startMarker, { force: true }) } catch { /* Not present. */ }
      }
      child = await start(startTarget, useMarker)
      if (useMarker && startMarker) {
        const deadline = Date.now() + 12000
        while (Date.now() < deadline) {
          if (fs.existsSync(startMarker)) return
          if (!isAlive(child.pid)) break
          await sleep(250)
        }
        lastError = new Error(`${label}未完成启动`)
        log(`${label} did not report ready (pid=${child.pid}, attempt=${attempt})`)
        try { child.kill() } catch { /* already gone */ }
      } else {
        await sleep(2500)
        if (isAlive(child.pid)) return
        lastError = new Error(`${label}启动后退出`)
        log(`${label} exited early (pid=${child.pid}, attempt=${attempt})`)
      }
    } catch (error) {
      lastError = error
      log(`${label} start failed: ${error.message}`)
    }
    if (child) {
      try { if (isAlive(child.pid)) child.kill() } catch { /* already gone */ }
    }
    await sleep(1000)
  }
  throw lastError || new Error(`${label}启动失败`)
}

async function main() {
  log(`helper start mode=${mode} pid=${targetPid} target=${target} new=${incoming}`)
  for (const required of [target, incoming, backupPath, startExe]) {
    if (!required) throw new Error('缺少更新参数')
  }
  if (!fs.existsSync(incoming)) throw new Error(`新文件不存在：${incoming}`)
  if (!fs.existsSync(target)) throw new Error(`目标文件不存在：${target}`)

  const deadline = Date.now() + 60000
  while (targetPid > 0 && isAlive(targetPid) && Date.now() < deadline) {
    await sleep(400)
  }
  await sleep(1000)

  let backupReady = false
  try {
    try {
      if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true })
    } catch (error) {
      log(`stale backup removal failed: ${error.message}`)
    }
    fs.copyFileSync(target, backupPath)
    if (fileHash(backupPath) !== fileHash(target)) throw new Error('备份校验失败')
    backupReady = true
    log(`backup created: ${backupPath}`)
    await replaceFile(incoming, target)
    if (fileHash(target) !== fileHash(incoming)) throw new Error('替换后校验失败')
    log(`replaced ${target}`)
    await startVerified('new version', Boolean(startMarker))
    log(`new version started: ${startTarget}`)
  } catch (error) {
    log(`update failed: ${error.message}`)
    try {
      if (backupReady && fs.existsSync(backupPath)) await replaceFile(backupPath, target)
      await startVerified('previous version')
      log('rolled back and restarted')
    } catch (rollbackError) {
      log(`rollback failed: ${rollbackError.message}`)
      process.exit(1)
    }
  }
}

main().catch(error => {
  log(error.stack || error.message || String(error))
  process.exit(1)
})
