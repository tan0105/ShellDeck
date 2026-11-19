const fs = require('node:fs')
const path = require('node:path')
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
function start(file) {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(file, [], {
      cwd: path.dirname(file),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
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

  try {
    fs.copyFileSync(target, backupPath)
    log(`backup created: ${backupPath}`)
    await replaceFile(incoming, target)
    log(`replaced ${target}`)
    await start(startExe)
    log(`new version started: ${startExe}`)
  } catch (error) {
    log(`update failed: ${error.message}`)
    try {
      if (fs.existsSync(backupPath)) await replaceFile(backupPath, target)
      await start(startExe)
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
