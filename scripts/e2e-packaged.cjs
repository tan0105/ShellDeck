const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const appDir = process.env.SHELLDECK_APP_DIR || path.join(root, 'release', 'ShellDeck', 'runtime')
const appExeName = process.env.SHELLDECK_APP_EXE || 'ShellDeckRuntime.exe'
const dataDir = process.env.SHELLDECK_DATA_DIR || path.join(os.tmpdir(), 'shelldeck-e2e-packaged-data')
const shotDir = path.join(root, 'screenshots')
const tmpDir = path.join(root, '.e2e-tmp')

function log(step, value = '') {
  console.log(`[packaged] ${step}${value ? ': ' + value : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(appDir, appExeName))) throw new Error('packaged build missing, run npm run dist first')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(shotDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const updateSrc = path.join(tmpDir, 'packaged-update-src')
  fs.rmSync(updateSrc, { recursive: true, force: true })
  fs.mkdirSync(updateSrc, { recursive: true })
  const fakeExe = path.join(updateSrc, 'ShellDeck-0.2.0.exe')
  fs.writeFileSync(fakeExe, Buffer.from('packaged update test'))
  const bytes = fs.readFileSync(fakeExe)
  const manifest = {
    schemaVersion: 1,
    appId: 'com.shelldeck.desktop',
    channel: 'stable',
    version: '0.2.0',
    publishedAt: new Date().toISOString(),
    minSupportedVersion: '0.0.1',
    notes: '打包版更新校验',
    assets: { 'win-x64': { url: 'ShellDeck-0.2.0.exe', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } },
  }
  const raw = Buffer.from(JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(updateSrc, 'release.json'), raw)
  fs.writeFileSync(path.join(updateSrc, 'release.json.sig'), crypto.sign(null, raw, fs.readFileSync(path.join(root, '.release-keys', 'private.pem'))).toString('base64'))

  const app = await electron.launch({
    executablePath: path.join(appDir, appExeName),
    args: ['--no-sandbox'],
    cwd: appDir,
    env: { ...process.env, SHELLDECK_DATA_DIR: dataDir, SHELLDECK_START_HIDDEN: '0' },
    timeout: 60000,
  })
  const watchdog = setTimeout(async () => {
    console.error('[packaged] watchdog timeout')
    try { await app.close() } catch { /* gone */ }
    process.exit(2)
  }, 90000)
  watchdog.unref()

  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => console.log('[page error]', error.message))
    page.on('console', message => {
      if (message.type() === 'error') console.log('[renderer error]', message.text())
    })
    await page.waitForSelector('.ssh-workspace', { timeout: 25000 })
    const info = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged,
      version: electronApp.getVersion(),
      appPath: electronApp.getAppPath(),
      resourcesPath: process.resourcesPath,
    }))
    if (!info.packaged) throw new Error('expected packaged app')
    if (!fs.existsSync(path.join(info.resourcesPath, 'update-helper.ps1'))) throw new Error('update helper missing from resources')
    const shellInfo = await page.evaluate(() => window.shellDeck.app.info())
    if (process.env.SHELLDECK_EXPECT_FOLDER === '1' && !shellInfo.folderMode) throw new Error('expected folder mode, got: ' + JSON.stringify(shellInfo))
    log('packaged app info', JSON.stringify(info))
    log('folder mode', String(shellInfo.folderMode))
    await page.locator('.ssh-topactions button', { hasText: '设置' }).click()
    await page.waitForSelector('.settings-dialog')
    const settingsText = await page.locator('.settings-dialog').textContent()
    if (!settingsText.includes('测速后选择最快')) throw new Error('accelerator settings missing')
    const accelOptions = await page.locator('.settings-dialog select option').allTextContents()
    if (!accelOptions.some(text => text.includes('ghproxy.net'))) throw new Error('built-in accelerators missing')
    if (settingsText.includes('owner/repo')) throw new Error('GitHub repo should be built in')
    await page.locator('.settings-dialog .um-close').click()

    const dbPath = path.join(dataDir, 'ssh.db')
    if (!fs.existsSync(dbPath)) throw new Error('database was not created in the data directory')
    log('database created in data dir', dbPath)

    await page.evaluate(() => window.shellDeck.settings.set('update.autoCheck', '0'))
    await page.locator('button.ssh-newserver').click()
    const inputs = page.locator('.sd-dialog input')
    await inputs.nth(0).fill('打包测试机')
    await inputs.nth(1).fill('127.0.0.1')
    await inputs.nth(2).fill('12222')
    await inputs.nth(3).fill('tester')
    await inputs.nth(4).fill('testpw')
    await page.locator('.sd-dialog .um-primary').click()
    await page.waitForSelector('.ssh-serverrow', { timeout: 10000 })

    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开终端' }).click()
    await page.waitForSelector('.termtile', { timeout: 10000 })
    try {
      await page.waitForFunction(() => !document.querySelector('.termtile .pv-terminal-mask'), null, { timeout: 20000 })
    } catch (error) {
      const mask = await page.locator('.termtile .pv-terminal-mask').textContent().catch(() => '(no mask)')
      await page.screenshot({ path: path.join(shotDir, 'folder-terminal-fail.png') })
      throw new Error('terminal did not become ready: ' + mask)
    }
    await page.locator('.termtile .xterm-helper-textarea').focus()
    await page.keyboard.type('echo PACKAGED_OK')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.termtile .xterm-rows')?.textContent.includes('PACKAGED_OK'), null, { timeout: 10000 })
    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开文件' }).click()
    await page.waitForFunction(() => document.querySelector('.filetile .ssh-filetable')?.textContent.includes('notes.txt'), null, { timeout: 20000 })
    await page.screenshot({ path: path.join(shotDir, '09-packaged.png') })
    log('packaged terminal and sftp ok')

    const updateResult = await page.evaluate(async dir => {
      await window.shellDeck.updater.addSource({ name: '打包版测试源', type: 'local', baseUrl: dir, priority: 1, enabled: true })
      const checked = await window.shellDeck.updater.check()
      const downloaded = await window.shellDeck.updater.download()
      return { checked, downloaded }
    }, updateSrc)
    if (updateResult.checked.status !== 'available') throw new Error('packaged update check failed: ' + JSON.stringify(updateResult.checked))
    if (updateResult.downloaded.status !== 'ready') throw new Error('packaged update download failed: ' + JSON.stringify(updateResult.downloaded))
    await page.waitForFunction(() => document.querySelector('.ssh-version-badge')?.textContent.includes('待安装'), null, { timeout: 5000 })
    await page.locator('.ssh-version').click()
    await page.waitForSelector('.update-dialog')
    const updateDialogText = await page.locator('.update-dialog').innerText()
    for (const text of ['0.2.0', '重启安装', '下次再说']) {
      if (!updateDialogText.includes(text)) throw new Error('packaged update dialog missing ' + text)
    }
    if (!(await page.locator('.update-dialog .update-box').isVisible())) throw new Error('update details are not rendered')
    if (!(await page.locator('.update-dialog .um-dialog-actions .um-primary', { hasText: '重启安装' }).isVisible())) throw new Error('update action is not rendered')
    const actions = await page.locator('.update-dialog .um-dialog-actions button').count()
    if (actions !== 2) throw new Error('expected exactly two update actions, got ' + actions)
    await page.locator('.update-dialog .um-dialog-actions .um-primary', { hasText: '重启安装' }).click()
    await page.waitForSelector('.update-confirm-overlay', { timeout: 5000 })
    const confirmText = await page.locator('.update-confirm-overlay').innerText()
    if (!confirmText.includes('是否立即重启并安装')) throw new Error('restart confirmation missing')
    await page.locator('.update-confirm-overlay .um-dialog-actions button', { hasText: '稍后' }).click()
    await page.waitForSelector('.update-confirm-overlay', { state: 'detached', timeout: 5000 })
    await page.locator('.update-dialog .um-close').click()
    log('packaged signed update check/download and dialog ok')

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1500, 950)
      win.setPosition(30, 30)
    })
    await page.waitForTimeout(1200)
    const savedWindowState = await page.evaluate(() => window.shellDeck.settings.get('windowState'))
    const parsedWindowState = JSON.parse(savedWindowState || '{}')
    if (parsedWindowState.width !== 1500 || parsedWindowState.height !== 950) {
      throw new Error('window state was not saved: ' + savedWindowState)
    }
    log('window state saved')

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.waitForTimeout(800)
    const hidden = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return win ? !win.isVisible() : true
    })
    if (!hidden) throw new Error('packaged close-to-tray failed')
    log('packaged close-to-tray ok')
  } finally {
    clearTimeout(watchdog)
    await app.close().catch(() => {})
  }
}

main().then(() => {
  log('done')
  process.exit(0)
}).catch(error => {
  console.error('[packaged] FAILED', error && error.stack ? error.stack : error)
  process.exit(1)
})
