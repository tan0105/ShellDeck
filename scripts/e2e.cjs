const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const dataDir = path.join(root, '.e2e-data')
const userDataDir = path.join(root, '.e2e-userdata')
const shotDir = path.join(root, 'screenshots')
const tmpDir = path.join(root, '.e2e-tmp')

function log(step, value = '') {
  console.log(`[e2e] ${step}${value ? ': ' + value : ''}`)
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(shotDir, { recursive: true })

  const uploadLocal = path.join(tmpDir, 'upload-e2e.txt')
  fs.writeFileSync(uploadLocal, 'shelldeck upload test\n', 'utf8')
  const downloadLocal = path.join(tmpDir, 'download-e2e.txt')

  const updateSrc = path.join(tmpDir, 'update-src')
  fs.mkdirSync(updateSrc, { recursive: true })
  const fakeExe = path.join(updateSrc, 'ShellDeck-0.2.0.exe')
  fs.writeFileSync(fakeExe, Buffer.from('fake portable exe for update test'))
  const exeBytes = fs.readFileSync(fakeExe)
  const manifest = {
    schemaVersion: 1,
    appId: 'com.shelldeck.desktop',
    channel: 'stable',
    version: '0.2.0',
    publishedAt: new Date().toISOString(),
    minSupportedVersion: '0.0.1',
    notes: 'E2E 更新清单测试',
    assets: {
      'win-x64': {
        url: 'ShellDeck-0.2.0.exe',
        size: exeBytes.length,
        sha256: crypto.createHash('sha256').update(exeBytes).digest('hex'),
      },
    },
  }
  const manifestRaw = Buffer.from(JSON.stringify(manifest, null, 2))
  const manifestPath = path.join(updateSrc, 'release.json')
  fs.writeFileSync(manifestPath, manifestRaw)
  const privateKey = fs.readFileSync(path.join(root, '.release-keys', 'private.pem'))
  fs.writeFileSync(path.join(updateSrc, 'release.json.sig'), crypto.sign(null, manifestRaw, privateKey).toString('base64'))

  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
    cwd: root,
    env: { ...process.env, SHELLDECK_DATA_DIR: dataDir, SHELLDECK_START_HIDDEN: '0' },
    timeout: 60000,
  })
  const watchdog = setTimeout(async () => {
    console.error('[e2e] watchdog timeout, closing app')
    try { await app.close() } catch { /* already gone */ }
    process.exit(2)
  }, 100000)
  watchdog.unref()

  try {
    const page = await app.firstWindow()
    page.on('console', message => {
      if (message.type() === 'error') console.log('[renderer error]', message.text())
    })
    page.on('pageerror', error => console.log('[page error]', error.message))

    await page.waitForSelector('.ssh-workspace', { timeout: 20000 })
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) { win.setSize(1880, 1000); win.center() }
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(shotDir, '01-empty.png') })
    const hasDropPath = await page.evaluate(() => typeof window.shellDeck.getPathForFile === 'function')
    if (!hasDropPath) throw new Error('getPathForFile is not exposed')
    await page.evaluate(() => window.shellDeck.settings.set('update.autoCheck', '0'))
    log('window ready at 1920x1080')

    await page.locator('button.ssh-newserver').click()
    await page.waitForSelector('.sd-dialog')
    const inputs = page.locator('.sd-dialog input')
    await inputs.nth(0).fill('本地测试机')
    await inputs.nth(1).fill('127.0.0.1')
    await inputs.nth(2).fill('12222')
    await inputs.nth(3).fill('tester')
    await inputs.nth(4).fill('testpw')
    await inputs.nth(5).fill('测试, 本地')
    await inputs.nth(6).fill('端到端测试服务器')
    await page.screenshot({ path: path.join(shotDir, '02-server-form.png') })
    await page.locator('.sd-dialog .um-primary').click()
    await page.waitForSelector('.ssh-serverrow', { timeout: 10000 })
    log('server saved')

    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开终端' }).click()
    log('terminal button clicked')
    await page.waitForSelector('.termtile', { timeout: 10000 })
    log('terminal tile created')
    await page.waitForTimeout(2500)
    await page.screenshot({ path: path.join(shotDir, '03-terminal-pending.png') })
    const maskText = await page.locator('.termtile .pv-terminal-mask').textContent().catch(() => 'no mask (ready)')
    log('terminal mask state', JSON.stringify(maskText))
    await page.waitForFunction(() => !document.querySelector('.termtile .pv-terminal-mask'), null, { timeout: 20000 })
    log('terminal ready')
    await page.locator('.termtile .xterm-helper-textarea').focus()
    await page.keyboard.type('echo SHELLDECK_OK')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.termtile .xterm-rows')?.textContent.includes('SHELLDECK_OK'), null, { timeout: 10000 })
    await page.screenshot({ path: path.join(shotDir, '04-terminal.png') })
    log('terminal roundtrip ok')

    await page.locator('.ssh-topactions button', { hasText: '常用指令' }).click()
    await page.waitForSelector('.cd-dialog')
    await page.locator('.cd-editor input').first().fill('E2E 命令')
    await page.locator('.cd-editor textarea').fill('echo CMD_OK')
    await page.locator('.cd-editor .um-primary').click()
    await page.waitForFunction(() => document.querySelector('.cd-items')?.textContent.includes('E2E 命令'), null, { timeout: 10000 })
    await page.locator('.cd-editor input').first().fill('E2E 参数')
    await page.locator('.cd-editor textarea').fill('echo PARAM_{{value}}')
    await page.locator('.cd-editor .um-primary').click()
    await page.waitForFunction(() => document.querySelector('.cd-items')?.textContent.includes('E2E 参数'), null, { timeout: 10000 })
    await page.locator('.cd-dialog .um-close').click()
    await page.locator('.termtile .ssh-cmdselect').selectOption({ label: '命令 · E2E 命令' })
    await page.locator('.termtile .ssh-cmdrun').click()
    await page.waitForFunction(() => document.querySelector('.termtile .xterm-rows')?.textContent.includes('CMD_OK'), null, { timeout: 10000 })
    await page.locator('.termtile .ssh-cmdselect').selectOption({ label: '命令 · E2E 参数' })
    await page.locator('.termtile .ssh-cmdrun').click()
    await page.waitForSelector('.ssh-param-dialog', { timeout: 10000 })
    await page.locator('.ssh-param-dialog input').fill('HELLO')
    await page.locator('.ssh-param-dialog .um-primary').click()
    await page.waitForFunction(() => document.querySelector('.termtile .xterm-rows')?.textContent.includes('PARAM_HELLO'), null, { timeout: 10000 })
    log('quick commands and parameters ok')

    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开文件' }).click()
    log('file button clicked')
    await page.waitForSelector('.filetile', { timeout: 10000 })
    await page.waitForFunction(() => document.querySelector('.filetile .ssh-filetable')?.textContent.includes('notes.txt'), null, { timeout: 20000 })
    await page.screenshot({ path: path.join(shotDir, '05-files.png') })
    log('file listing ok')

    const metrics = await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector)
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
      }
      const table = document.querySelector('.filetile .ssh-filetablewrap')
      return {
        viewport: { w: innerWidth, h: innerHeight },
        overflow: document.documentElement.scrollWidth - innerWidth,
        rail: rect('.ssh-rail'),
        selbar: rect('.ssh-selbar'),
        toolbar: rect('.ssh-toolbar'),
        grid: rect('.ssh-grid'),
        termTile: rect('.termtile'),
        fileTile: rect('.filetile'),
        termScreen: rect('.termtile .xterm-screen'),
        fileTable: rect('.filetile .ssh-filetablewrap'),
        fileTableScroll: table ? { clientW: table.clientWidth, scrollW: table.scrollWidth, clientH: table.clientHeight, scrollH: table.scrollHeight } : null,
      }
    })
    if (metrics.overflow > 1) throw new Error('page has horizontal overflow: ' + metrics.overflow)
    if (!metrics.rail || metrics.rail.w < 250 || metrics.rail.w > 270) throw new Error('rail width unexpected: ' + JSON.stringify(metrics.rail))
    if (!metrics.termScreen || metrics.termScreen.w < 200 || metrics.termScreen.h < 100) throw new Error('terminal canvas too small: ' + JSON.stringify(metrics.termScreen))
    if (!metrics.fileTable || metrics.fileTable.w < 150 || metrics.fileTable.h < 80) throw new Error('file table too small: ' + JSON.stringify(metrics.fileTable))
    for (const [name, box] of Object.entries(metrics)) {
      if (!box || typeof box !== 'object' || !('x' in box)) continue
      if (box.x < -1 || box.y < -1 || box.x + box.w > metrics.viewport.w + 1 || box.y + box.h > metrics.viewport.h + 1) {
        throw new Error(`${name} is outside viewport: ` + JSON.stringify(box))
      }
    }
    log('layout metrics ok', JSON.stringify({ viewport: metrics.viewport, rail: metrics.rail.w, term: metrics.termScreen, fileTable: metrics.fileTable, tableScroll: metrics.fileTableScroll }))

    const sftpResult = await page.evaluate(async ({ localPath, savePath }) => {
      const servers = await window.shellDeck.servers.list()
      const server = servers[0]
      const sessionId = 'e2e-sftp'
      const connected = await window.shellDeck.sftp.connect({ sessionId, server, sudo: false })
      const before = await window.shellDeck.sftp.list(sessionId, connected.home)
      await window.shellDeck.sftp.upload({
        sessionId,
        transferId: 'e2e-upload',
        targetDir: connected.home,
        files: [{ localPath, relative: 'upload-e2e.txt', size: 21 }],
        dirs: [],
        overwrite: true,
      })
      const after = await window.shellDeck.sftp.list(sessionId, connected.home)
      const downloaded = await window.shellDeck.sftp.download({
        sessionId,
        transferId: 'e2e-download',
        remotePath: connected.home.replace(/\/$/, '') + '/upload-e2e.txt',
        savePath,
      })
      await window.shellDeck.sftp.close(sessionId)
      return {
        home: connected.home,
        before: before.entries.map(entry => entry.name),
        after: after.entries.map(entry => entry.name),
        downloaded,
      }
    }, { localPath: uploadLocal, savePath: downloadLocal })

    const downloadedText = fs.readFileSync(downloadLocal, 'utf8').trim()
    if (downloadedText !== 'shelldeck upload test') throw new Error('download content mismatch: ' + downloadedText)
    log('sftp upload/download ok', JSON.stringify(sftpResult.after))

    const backupPath = await page.evaluate(() => window.shellDeck.app.backupDb())
    if (!fs.existsSync(backupPath)) throw new Error('backup file missing')
    log('backup ok', backupPath)

    const importResult = await page.evaluate(async () => window.shellDeck.servers.importMany([
      { 名称: '导入机', 主机: '10.0.0.9', 端口: 22, 账号: 'root', 密码: 'pw', 标签: '导入' },
      { 名称: '', 主机: '', 端口: 22, 账号: '', 密码: '' },
    ]))
    log('excel-style import ok', JSON.stringify(importResult))

    const updateError = await page.evaluate(async () => {
      try { await window.shellDeck.updater.check(); return '' }
      catch (error) { return error.message }
    })
    log('update check without source', updateError)
    if (!/更新源/.test(updateError)) throw new Error('expected update source error, got: ' + updateError)

    const updateResult = await page.evaluate(async dir => {
      await window.shellDeck.updater.addSource({ name: 'E2E 本地源', type: 'local', baseUrl: dir, priority: 1, enabled: true })
      const checked = await window.shellDeck.updater.check()
      const downloaded = await window.shellDeck.updater.download()
      let installError = ''
      try { await window.shellDeck.updater.install() } catch (error) { installError = error.message }
      return { checked, downloaded, installError }
    }, updateSrc)
    if (updateResult.checked.status !== 'available' || updateResult.checked.version !== '0.2.0') {
      throw new Error('update check did not find 0.2.0: ' + JSON.stringify(updateResult.checked))
    }
    if (updateResult.downloaded.status !== 'ready') throw new Error('update download failed: ' + JSON.stringify(updateResult.downloaded))
    if (!fs.existsSync(updateResult.downloaded.asset.localPath)) throw new Error('downloaded update file missing')
    if (!/开发模式/.test(updateResult.installError)) throw new Error('install guard missing: ' + updateResult.installError)
    log('signed update check/download ok')

    const tampered = { ...manifest, notes: 'tampered after signing' }
    fs.writeFileSync(manifestPath, JSON.stringify(tampered, null, 2))
    const tamperError = await page.evaluate(async () => {
      try { await window.shellDeck.updater.check(); return '' }
      catch (error) { return error.message }
    })
    if (!/签名/.test(tamperError)) throw new Error('expected signature rejection, got: ' + tamperError)
    log('tampered manifest rejected', tamperError)

    await page.locator('.ssh-topactions button', { hasText: '设置' }).click()
    await page.waitForSelector('.settings-dialog')
    await page.screenshot({ path: path.join(shotDir, '06-settings.png') })
    await page.locator('.settings-dialog .um-close').click()

    await page.locator('.ssh-topactions button', { hasText: '常用指令' }).click()
    await page.waitForSelector('.cd-dialog')
    await page.screenshot({ path: path.join(shotDir, '07-commands.png') })
    await page.locator('.cd-dialog .um-close').click()

    await page.screenshot({ path: path.join(shotDir, '08-workspace.png') })
    log('all screenshots captured')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.waitForTimeout(800)
    const trayState = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return { exists: Boolean(win), visible: win ? win.isVisible() : false }
    })
    if (!trayState.exists || trayState.visible) throw new Error('close-to-tray did not hide the window: ' + JSON.stringify(trayState))
    log('close-to-tray ok')
  } finally {
    clearTimeout(watchdog)
    await app.close().catch(() => {})
  }

  const Database = require('better-sqlite3')
  const db = new Database(path.join(dataDir, 'ssh.db'), { readonly: true })
  try {
    const hosts = db.prepare('select count(*) as count from host_keys').get().count
    const servers = db.prepare('select count(*) as count from servers').get().count
    const commands = db.prepare('select count(*) as count from commands').get().count
    if (hosts < 1) throw new Error('host key was not recorded')
    if (servers !== 2) throw new Error('expected 2 servers, got ' + servers)
    if (commands !== 2) throw new Error('expected 2 commands, got ' + commands)
    log('database state ok', JSON.stringify({ hosts, servers, commands }))
  } finally {
    db.close()
  }
}

main().then(() => {
  log('done')
  process.exit(0)
}).catch(error => {
  console.error('[e2e] FAILED', error && error.stack ? error.stack : error)
  process.exit(1)
})
