const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const builtDir = process.env.SHELLDECK_APP_DIR || path.join(root, 'release', 'ShellDeck', 'runtime')
const appExeName = process.env.SHELLDECK_APP_EXE || 'ShellDeckRuntime.exe'
const testDir = path.join(root, '..', 'ShellDeck-build', 'helper-test')
const exePath = path.join(testDir, appExeName)
const helper = path.join(testDir, 'resources', 'update-helper.ps1')
const backup = path.join(testDir, 'ShellDeck.previous.exe')
const logPath = path.join(testDir, 'data', 'updates', 'update.log')
const tmpDir = path.join(root, '.e2e-tmp', 'helper-install')

function log(step, value = '') {
  console.log(`[helper] ${step}${value ? ': ' + value : ''}`)
}
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function runHelper(targetPid, newExe) {
  return new Promise((resolve, reject) => {
    const output = []
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-AppExe', exePath,
      '-NewExe', newExe,
      '-Backup', backup,
      '-TargetPid', String(targetPid),
      '-ParentPid', '0',
      '-LogPath', logPath,
    ], { windowsHide: true })
    child.stdout.on('data', chunk => output.push(chunk.toString()))
    child.stderr.on('data', chunk => output.push(chunk.toString()))
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 30000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(output.join(''))
      else reject(new Error(`helper exited ${code}: ${output.join('')}`))
    })
  })
}

function stopTestApp() {
  const command = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exePath.replace(/'/g, "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'ignore' }) } catch { /* none */ }
}
function appRunning() {
  const command = `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exePath.replace(/'/g, "''")}' }).Count`
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim()
    return Number(out) > 0
  } catch { return false }
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(400)
  }
  return check()
}

async function removeWithRetry(target, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (i === attempts - 1) throw error
      await sleep(800)
    }
  }
}

async function main() {
  if (!fs.existsSync(path.join(builtDir, appExeName))) throw new Error('packaged build missing')
  if (!fs.existsSync(path.join(builtDir, 'resources', 'update-helper.ps1'))) throw new Error('update-helper.ps1 missing from packaged resources')
  stopTestApp()
  fs.rmSync(testDir, { recursive: true, force: true })
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  log('copying app tree')
  fs.cpSync(builtDir, testDir, { recursive: true })

  const originalHash = hash(exePath)
  const newExe = path.join(tmpDir, 'ShellDeck-0.2.0.exe')
  fs.copyFileSync(exePath, newExe)
  fs.appendFileSync(newExe, Buffer.from('\nSHELLDECK-UPDATE-MARKER\n'))
  const newHash = hash(newExe)

  log('testing replace and relaunch')
  const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  setTimeout(() => { try { dummy.kill() } catch { /* gone */ } }, 1200)
  await runHelper(dummy.pid, newExe)
  if (!await waitFor(() => fs.existsSync(exePath) && hash(exePath) === newHash, 15000)) throw new Error('executable was not replaced')
  if (!await waitFor(() => fs.existsSync(backup) && hash(backup) === originalHash, 10000)) throw new Error('backup executable missing or incorrect')
  if (!await waitFor(appRunning, 15000)) throw new Error('new version was not started')
  let logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  if (!/new version started/.test(logText)) throw new Error('helper log missing new version start: ' + logText)
  log('replace, backup and relaunch ok')
  stopTestApp()
  await sleep(1200)

  log('testing failed start rollback')
  fs.copyFileSync(backup, exePath)
  const brokenExe = path.join(tmpDir, 'Broken.exe')
  fs.writeFileSync(brokenExe, 'not a windows executable')
  const dummy2 = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  setTimeout(() => { try { dummy2.kill() } catch { /* gone */ } }, 1200)
  await runHelper(dummy2.pid, brokenExe)
  if (!await waitFor(() => fs.existsSync(exePath) && hash(exePath) === originalHash, 15000)) throw new Error('rollback did not restore the original executable')
  if (!await waitFor(appRunning, 15000)) throw new Error('rolled back version was not started')
  logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  if (!/rolled back and restarted/.test(logText)) throw new Error('helper log missing rollback: ' + logText)
  log('rollback and restart ok')
  stopTestApp()

  log('testing asar replacement')
  const targetAsar = path.join(testDir, 'resources', 'app.asar')
  const backupAsar = targetAsar + '.previous'
  const newPayload = path.join(tmpDir, 'payload.bin')
  const originalAsarHash = hash(targetAsar)
  fs.copyFileSync(targetAsar, newPayload)
  fs.appendFileSync(newPayload, Buffer.from('ASAR-UPDATE-MARKER'))
  const newAsarHash = hash(newPayload)
  const asarDummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  setTimeout(() => { try { asarDummy.kill() } catch { /* gone */ } }, 1200)
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Mode', 'asar',
      '-Launcher', 'C:/Windows/System32/whoami.exe',
      '-TargetFile', targetAsar,
      '-NewFile', newPayload,
      '-BackupFile', backupAsar,
      '-TargetPid', String(asarDummy.pid),
      '-LogPath', logPath,
    ], { windowsHide: true })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error('asar helper exited ' + code)))
  })
  if (!await waitFor(() => fs.existsSync(targetAsar) && hash(targetAsar) === newAsarHash, 15000)) throw new Error('asar was not replaced')
  if (!await waitFor(() => fs.existsSync(backupAsar) && hash(backupAsar) === originalAsarHash, 10000)) throw new Error('asar backup incorrect')
  const asarLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  if (!/new version started/.test(asarLog)) throw new Error('helper log missing asar start: ' + asarLog)
  log('asar replace and backup ok')

  stopTestApp()
  await waitFor(() => !appRunning(), 6000)
  await sleep(800)
  await removeWithRetry(testDir)
}

main().then(() => {
  log('done')
  process.exit(0)
}).catch(error => {
  console.error('[helper] FAILED', error && error.stack ? error.stack : error)
  stopTestApp()
  process.exit(1)
})
