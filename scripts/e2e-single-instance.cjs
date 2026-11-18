const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const dataDir = path.join(root, '.e2e-instance-data')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const instanceExe = process.env.SHELLDECK_INSTANCE_EXE || electronExe
const isPackagedExe = instanceExe !== electronExe
const launchCwd = isPackagedExe ? path.dirname(instanceExe) : root
const launchArgs = isPackagedExe ? ['--no-sandbox'] : ['.', '--no-sandbox']

function log(step, value = '') {
  console.log(`[instance] ${step}${value ? ': ' + value : ''}`)
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function launchSecond() {
  return new Promise(resolve => {
    const child = spawn(instanceExe, launchArgs, {
      cwd: launchCwd,
      env: { ...process.env, SHELLDECK_DATA_DIR: dataDir, SHELLDECK_START_HIDDEN: '0' },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, 15000)
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
    child.on('error', () => { clearTimeout(timer); resolve(-1) })
  })
}

async function windowState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win
      ? { visible: win.isVisible(), maximized: win.isMaximized(), minimized: win.isMinimized(), bounds: win.getBounds() }
      : null
  })
}

async function waitForState(app, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await windowState(app)
    if (predicate(state)) return state
    await sleep(250)
  }
  return windowState(app)
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true })
  const app = await electron.launch({
    executablePath: instanceExe,
    args: launchArgs,
    cwd: launchCwd,
    env: { ...process.env, SHELLDECK_DATA_DIR: dataDir, SHELLDECK_START_HIDDEN: '0' },
    timeout: 60000,
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.ssh-workspace', { timeout: 20000 })
    await sleep(400)
    const before = await windowState(app)
    if (!before.visible || before.maximized) throw new Error('first launch should not be maximized: ' + JSON.stringify(before))

    let code = await launchSecond()
    let state = await waitForState(app, value => value && value.visible && !value.maximized)
    if (!state.visible || state.maximized) throw new Error('second launch should restore without maximizing: ' + JSON.stringify(state))
    if (state.bounds.width !== before.bounds.width || state.bounds.height !== before.bounds.height) {
      throw new Error('second launch changed window size: ' + JSON.stringify({ before: before.bounds, after: state.bounds }))
    }
    if (code !== 0) throw new Error('second process exit code: ' + code)
    log('second launch restored existing window at original size')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await sleep(800)
    const hidden = await windowState(app)
    if (!hidden || hidden.visible) throw new Error('window was not hidden to tray: ' + JSON.stringify(hidden))

    code = await launchSecond()
    state = await waitForState(app, value => value && value.visible && !value.maximized)
    if (!state.visible || state.maximized) throw new Error('second launch should restore from tray without maximizing: ' + JSON.stringify(state))
    if (state.bounds.width !== before.bounds.width || state.bounds.height !== before.bounds.height) {
      throw new Error('second launch changed window size after tray: ' + JSON.stringify({ before: before.bounds, after: state.bounds }))
    }
    if (code !== 0) throw new Error('second process exit code: ' + code)
    log('second launch restored from tray at original size')
  } finally {
    await app.close().catch(() => {})
  }
}

main().then(() => {
  log('done')
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}).catch(error => {
  console.error('[instance] FAILED', error && error.stack ? error.stack : error)
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(1)
})
