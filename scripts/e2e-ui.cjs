const fs = require('node:fs')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const dataDir = path.join(root, '.e2e-ui-data')
const userDataDir = path.join(root, '.e2e-ui-userdata')

function log(step, value = '') {
  console.log(`[ui] ${step}${value ? ': ' + value : ''}`)
}

async function pageLabel(page) {
  return (await page.locator('.ssh-pagebar span').textContent()).trim()
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  const packagedExe = process.env.SHELLDECK_UI_EXE || ''
  const app = await electron.launch({
    executablePath: packagedExe || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: packagedExe ? ['--no-sandbox', `--user-data-dir=${userDataDir}`] : ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
    cwd: packagedExe ? path.dirname(packagedExe) : root,
    env: { ...process.env, SHELLDECK_DATA_DIR: dataDir, SHELLDECK_START_HIDDEN: '0' },
    timeout: 60000,
  })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', error => console.log('[page error]', error.message))
    await page.waitForSelector('.ssh-workspace', { timeout: 20000 })
    await page.evaluate(() => window.shellDeck.settings.set('update.autoCheck', '0'))

    await page.locator('button.ssh-newserver').click()
    const inputs = page.locator('.sd-dialog input')
    await inputs.nth(0).fill('右键测试机')
    await inputs.nth(1).fill('127.0.0.1')
    await inputs.nth(2).fill('12222')
    await inputs.nth(3).fill('tester')
    await inputs.nth(4).fill('testpw')
    await page.locator('.sd-dialog .um-primary').click()
    await page.waitForSelector('.ssh-serverrow', { timeout: 10000 })

    const row = page.locator('.ssh-serverrow').first()
    await row.dblclick()
    await page.waitForSelector('.sd-dialog', { timeout: 5000 })
    await page.locator('.sd-dialog .um-close').click()
    await page.waitForTimeout(300)
    if (await page.locator('.ssh-session-picker').count()) throw new Error('double-click still opens the session picker')
    log('double-click opens server editor')

    await row.click({ button: 'right' })
    await page.waitForSelector('.server-menu', { timeout: 5000 })
    const menuText = await page.locator('.server-menu').textContent()
    if (!/打开终端/.test(menuText) || !/打开文件/.test(menuText)) throw new Error('server menu items missing')
    await page.locator('.server-menu button', { hasText: '打开终端' }).click()
    await page.waitForSelector('.termtile', { timeout: 10000 })
    await page.waitForFunction(() => !document.querySelector('.termtile .pv-terminal-mask'), null, { timeout: 20000 })
    log('right-click terminal ok')

    await row.click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开文件' }).click()
    await page.waitForSelector('.filetile', { timeout: 10000 })
    await page.waitForFunction(() => document.querySelector('.filetile .ssh-filetable')?.textContent.includes('notes.txt'), null, { timeout: 20000 })
    log('right-click file ok')

    for (let i = 0; i < 3; i += 1) {
      await row.click({ button: 'right' })
      await page.locator('.server-menu button', { hasText: '打开终端' }).click()
      await page.waitForSelector('.ssh-confirm-dialog', { timeout: 5000 })
      await page.locator('.ssh-confirm-dialog .um-primary').click()
      await page.waitForFunction(count => document.querySelectorAll('.ssh-tile').length === count, i + 3, { timeout: 5000 })
    }
    const total = await page.locator('.ssh-tile').count()
    if (total !== 5) throw new Error('expected 5 sessions, got ' + total)
    log('5 sessions opened', String(total))
    if ((await pageLabel(page)).startsWith('2 /')) {
      await page.locator('.ssh-pagebar button', { hasText: '‹' }).click()
    }

    const visible = () => page.locator('.ssh-tile:not(.session-hidden)').count()
    if (await pageLabel(page) !== '1 / 2 页') throw new Error('layout 4 page label: ' + await pageLabel(page))
    if (await visible() !== 4) throw new Error('layout 4 visible tiles: ' + await visible())
    if (await page.locator('.ssh-zoom b').textContent() !== '95%') throw new Error('auto text scale not applied for layout 4')
    log('layout 4 -> 1 / 2 pages, 4 visible, auto 95%')

    await page.locator('.ssh-layout button', { hasText: '9' }).click()
    if (await pageLabel(page) !== '1 / 1 页') throw new Error('layout 9 page label: ' + await pageLabel(page))
    if (await visible() !== 5) throw new Error('layout 9 visible tiles: ' + await visible())
    if (await page.locator('.ssh-zoom b').textContent() !== '85%') throw new Error('auto text scale not applied for layout 9')
    log('layout 9 -> 1 / 1 pages, 5 visible, auto 85%')

    await page.locator('.ssh-layout button', { hasText: '1' }).click()
    if (await pageLabel(page) !== '1 / 5 页') throw new Error('layout 1 page label: ' + await pageLabel(page))
    if (await visible() !== 1) throw new Error('layout 1 visible tiles: ' + await visible())
    if (await page.locator('.ssh-zoom b').textContent() !== '100%') throw new Error('auto text scale not applied for layout 1')
    for (let i = 0; i < 4; i += 1) {
      await page.locator('.ssh-pagebar button', { hasText: '›' }).click()
    }
    if (await pageLabel(page) !== '5 / 5 页') throw new Error('page navigation failed: ' + await pageLabel(page))
    log('layout 1 -> 5 pages, navigation ok')

    await page.locator('.ssh-layout button', { hasText: '9' }).click()
    if (await pageLabel(page) !== '1 / 1 页') throw new Error('page was not clamped after layout switch: ' + await pageLabel(page))
    if (await visible() !== 5) throw new Error('layout 9 after clamp visible tiles: ' + await visible())
    log('page clamped after layout switch')

    await page.locator('.ssh-layout button', { hasText: '2' }).click()
    if (await pageLabel(page) !== '1 / 3 页') throw new Error('layout 2 page label: ' + await pageLabel(page))
    log('layout 2 -> 1 / 3 pages')

    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.waitForSelector('.server-menu')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.server-menu'), null, { timeout: 3000 })
    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.waitForSelector('.server-menu')
    await page.mouse.click(680, 420)
    await page.waitForFunction(() => !document.querySelector('.server-menu'), null, { timeout: 3000 })
    log('context menu closes on Escape and outside click')

    await page.screenshot({ path: path.join(root, 'screenshots', '10-layout-paging.png') })
  } finally {
    await app.close().catch(() => {})
  }
}

main().then(() => {
  log('done')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(0)
}).catch(error => {
  console.error('[ui] FAILED', error && error.stack ? error.stack : error)
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(1)
})
