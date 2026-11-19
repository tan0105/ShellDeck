const fs = require('node:fs')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const dataDir = path.join(root, '.e2e-filemenu')
const userDataDir = path.join(root, '.e2e-filemenu-userdata')

function log(step, value = '') {
  console.log(`[ui] ${step}${value ? ': ' + value : ''}`)
}
async function waitText(page, selector, text, timeout = 15000) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text }, { timeout })
}
async function menuClick(page, label) {
  await page.locator('.context-menu button', { hasText: label }).first().click()
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
    const versionText = (await page.locator('.ssh-version').textContent()).trim()
    if (!/^v\d+\.\d+\.\d+/.test(versionText)) throw new Error('version footer missing: ' + versionText)
    const newServerPinned = await page.evaluate(() => {
      const button = document.querySelector('.ssh-newserver')
      const list = document.querySelector('.ssh-serverlist')
      return Boolean(button && list && !list.contains(button))
    })
    if (!newServerPinned) throw new Error('new server button should be outside the scrolling list')
    await page.locator('.ssh-topactions button', { hasText: '设置' }).click()
    await page.waitForSelector('.settings-dialog')
    const settingsText = await page.locator('.settings-dialog').textContent()
    if (settingsText.includes('更新源')) throw new Error('legacy update source settings still visible')
    if (!settingsText.includes('直连失败后尝试加速')) throw new Error('accelerator settings missing')
    const accelOptions = await page.locator('.settings-dialog select option').allTextContents()
    if (!accelOptions.some(text => text.includes('ghproxy.net'))) throw new Error('built-in accelerators missing: ' + accelOptions.join(','))
    if (settingsText.includes('owner/repo')) throw new Error('GitHub repo should be built in')
    await page.selectOption('.settings-dialog select', 'ghproxy-net')
    await page.locator('.settings-dialog .settings-github .ssh-softbtn').click()
    await page.waitForFunction(async () => (await window.shellDeck.settings.get('update.accelerator')) === 'ghproxy-net', null, { timeout: 5000 })
    await page.selectOption('.settings-dialog select', 'auto')
    await page.locator('.settings-dialog .settings-github .ssh-softbtn').click()
    await page.waitForFunction(async () => (await window.shellDeck.settings.get('update.accelerator')) === 'auto', null, { timeout: 5000 })
    await page.locator('.settings-dialog .um-close').click()

    await page.locator('.ssh-topactions .theme-toggle').click()
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'))
    const darkColors = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      rail: getComputedStyle(document.querySelector('.ssh-rail')).backgroundColor,
    }))
    if (darkColors.body !== 'rgb(43, 43, 43)' || darkColors.rail !== 'rgb(60, 63, 65)') {
      throw new Error('dark theme colors not applied: ' + JSON.stringify(darkColors))
    }
    await page.locator('.ssh-topactions button', { hasText: '设置' }).click()
    await page.waitForSelector('.settings-dialog')
    const dialogColor = await page.evaluate(() => getComputedStyle(document.querySelector('.settings-dialog')).backgroundColor)
    if (dialogColor !== 'rgb(60, 63, 65)') throw new Error('dark dialog color not applied: ' + dialogColor)
    await page.locator('.settings-dialog .um-close').click()
    await page.locator('.ssh-topactions .theme-toggle').click()
    await page.waitForFunction(() => !document.documentElement.classList.contains('theme-dark'))
    log('day/night theme toggle ok')

    log('version footer, pinned new-server and settings cleanup ok')

    await page.locator('button.ssh-newserver').click()
    const inputs = page.locator('.sd-dialog input')
    await inputs.nth(0).fill('文件菜单测试')
    await inputs.nth(1).fill('127.0.0.1')
    await inputs.nth(2).fill('12222')
    await inputs.nth(3).fill('tester')
    await inputs.nth(4).fill('testpw')
    await page.locator('.sd-row', { hasText: '备注' }).locator('textarea').fill('文件菜单测试备注\n第二行')
    await page.locator('.sd-dialog .um-primary').click()
    await page.waitForSelector('.ssh-serverrow', { timeout: 10000 })
    const rowText = await page.locator('.ssh-serverrow').first().textContent()
    if (!rowText.includes('127.0.0.1') || !rowText.includes('文件菜单测试备注')) throw new Error('server row missing host/note')
    if (rowText.includes('tester') || rowText.includes('12222')) throw new Error('server row still shows username/port')

    const row = page.locator('.ssh-serverrow').first()
    await row.click({ button: 'right' })
    await page.waitForSelector('.server-menu')
    const serverMenu = await page.locator('.server-menu').textContent()
    for (const item of ['查看详情', '编辑服务器', '复制密码', '删除服务器']) {
      if (!serverMenu.includes(item)) throw new Error('server menu missing ' + item)
    }
    await page.locator('.server-menu button', { hasText: '查看详情' }).click()
    await page.waitForSelector('.server-detail-dialog')
    const detailText = await page.locator('.server-detail-dialog').textContent()
    for (const text of ['tester', '12222', '文件菜单测试备注', '第二行']) {
      if (!detailText.includes(text)) throw new Error('server detail missing ' + text)
    }
    await page.locator('.server-detail-dialog .um-close').click()

    await row.click({ button: 'right' })
    await page.waitForSelector('.server-menu')
    await page.locator('.server-menu button', { hasText: '编辑服务器' }).click()
    await page.waitForSelector('.sd-dialog')
    await page.locator('.sd-dialog .um-close').click()
    log('server detail and right-click edit ok')

    await row.click({ button: 'right' })
    await page.waitForSelector('.server-menu')
    await page.locator('.server-menu button', { hasText: '打开文件' }).click()
    await page.waitForSelector('.filetile', { timeout: 10000 })
    await waitText(page, '.filetile .ssh-filetable', 'notes.txt')

    const wrapper = page.locator('.filetile .ssh-filetablewrap')
    await wrapper.click({ button: 'right', position: { x: 300, y: 8 } })
    await page.waitForSelector('.context-menu')
    const blankMenu = await page.locator('.context-menu').textContent()
    for (const item of ['粘贴', '新建文件夹', '上传文件', '上传文件夹', '刷新']) {
      if (!blankMenu.includes(item)) throw new Error('blank menu missing ' + item)
    }
    await menuClick(page, '刷新')
    await waitText(page, '.filetile .ssh-filetable', 'notes.txt')
    log('blank menu + refresh ok')

    await page.locator('.filetile tbody tr', { hasText: 'notes.txt' }).click({ button: 'right' })
    await page.waitForSelector('.context-menu')
    const rowMenu = await page.locator('.context-menu').textContent()
    for (const item of ['复制', '剪切', '粘贴', '复制路径', '移动到', '重命名', '权限', '删除', '刷新']) {
      if (!rowMenu.includes(item)) throw new Error('row menu missing ' + item)
    }
    await menuClick(page, '复制')
    log('row menu ok')

    await page.locator('.filetile .ssh-filebtn', { hasText: 'docs' }).click()
    await waitText(page, '.filetile .ssh-filetable', 'readme.md')
    await wrapper.click({ button: 'right', position: { x: 300, y: 8 } })
    await menuClick(page, '粘贴')
    await waitText(page, '.filetile .ssh-filetable', 'notes.txt', 20000)
    log('copy + paste ok')

    await page.locator('.filetile tbody tr', { hasText: 'notes.txt' }).click({ button: 'right' })
    await page.waitForSelector('.context-menu')
    await menuClick(page, '移动到')
    await page.waitForSelector('.ssh-name-dialog')
    const moveInput = page.locator('.ssh-name-dialog input')
    const currentPath = await moveInput.inputValue()
    await moveInput.fill(currentPath.replace(/\/notes\.txt$/, '/notes-moved.txt'))
    await page.locator('.ssh-name-dialog .um-primary').click()
    await waitText(page, '.filetile .ssh-filetable', 'notes-moved.txt', 20000)
    const docsText = await page.locator('.filetile .ssh-filetable').textContent()
    if (docsText.includes('notes.txt') && !docsText.includes('notes-moved.txt')) throw new Error('move to path failed')
    log('move to path ok')

    await page.locator('.filetile .ssh-secondary', { hasText: '上一级' }).click()
    await waitText(page, '.filetile .ssh-filetable', 'notes.txt')
    await page.locator('.filetile tbody tr', { hasText: 'notes.txt' }).click({ button: 'right' })
    await menuClick(page, '复制')
    await wrapper.click({ button: 'right', position: { x: 300, y: 8 } })
    await menuClick(page, '粘贴')
    await waitText(page, '.filetile .ssh-filetable', 'notes - 副本.txt', 20000)
    log('same-directory paste creates a copy')

    await page.locator('.filetile .ssh-filebtn', { hasText: 'docs' }).click()
    await waitText(page, '.filetile .ssh-filetable', 'readme.md')
    await page.locator('.filetile tbody tr', { hasText: 'readme.md' }).click({ button: 'right' })
    await menuClick(page, '复制')
    await page.locator('.filetile .ssh-secondary', { hasText: '上一级' }).click()
    await waitText(page, '.filetile .ssh-filetable', 'notes.txt')
    await wrapper.click({ button: 'right', position: { x: 300, y: 8 } })
    await menuClick(page, '粘贴')
    await waitText(page, '.filetile .ssh-filetable', 'readme.md', 20000)
    await wrapper.click({ button: 'right', position: { x: 300, y: 8 } })
    await menuClick(page, '粘贴')
    await page.waitForSelector('.ssh-confirm-dialog', { timeout: 10000 })
    const conflictText = await page.locator('.ssh-confirm-dialog').textContent()
    if (!conflictText.includes('目标已存在')) throw new Error('overwrite dialog missing')
    await page.locator('.ssh-confirm-dialog .um-dialog-actions button', { hasText: '取消' }).click()
    log('overwrite dialog ok')

    await row.click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开终端' }).click()
    await page.waitForFunction(() => !document.querySelector('.termtile .pv-terminal-mask'), null, { timeout: 20000 })
    await page.evaluate(() => window.shellDeck.clipboard.write('echo TERM_RIGHT'))
    await page.locator('.termtile .pv-terminal').click({ button: 'right' })
    await page.waitForSelector('.context-menu')
    const termMenu = await page.locator('.context-menu').textContent()
    for (const item of ['复制', '粘贴', '全选', '清屏']) {
      if (!termMenu.includes(item)) throw new Error('terminal menu missing ' + item)
    }
    await menuClick(page, '粘贴')
    await page.locator('.termtile .xterm-helper-textarea').focus()
    await page.keyboard.press('Enter')
    await waitText(page, '.termtile .xterm-rows', 'TERM_RIGHT')
    await page.locator('.termtile .pv-terminal').click({ button: 'right' })
    await menuClick(page, '全选')
    await page.locator('.termtile .pv-terminal').click({ button: 'right' })
    await menuClick(page, '复制')
    await page.waitForTimeout(500)
    const copied = await page.evaluate(() => window.shellDeck.clipboard.read())
    if (!copied.includes('TERM_RIGHT')) throw new Error('terminal copy did not reach clipboard')
    log('terminal right-click copy/paste ok')

    const fonts = await page.evaluate(() => {
      const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
      return {
        server: size('.ssh-serverhost'),
        toolbar: size('.ssh-layout button'),
        fileTable: size('.filetile .ssh-filetable'),
        terminal: size('.termtile .xterm-rows'),
        overflow: document.documentElement.scrollWidth - innerWidth,
      }
    })
    if (fonts.server < 13) throw new Error('server host font too small: ' + fonts.server)
    if (fonts.toolbar < 12) throw new Error('toolbar font too small: ' + fonts.toolbar)
    if (fonts.fileTable < 12) throw new Error('file table font too small: ' + fonts.fileTable)
    if (fonts.terminal < 15) throw new Error('terminal font too small: ' + fonts.terminal)
    if (fonts.overflow > 1) throw new Error('horizontal overflow: ' + fonts.overflow)
    log('font sizes ok', JSON.stringify(fonts))
    await page.screenshot({ path: path.join(root, 'screenshots', '11-file-terminal-menus.png') })

    await page.evaluate(async () => {
      const servers = await window.shellDeck.servers.list()
      const sessionId = 'cleanup-sftp'
      const connected = await window.shellDeck.sftp.connect({ sessionId, server: servers[0], sudo: false })
      for (const remotePath of [
        connected.home + '/docs/notes.txt',
        connected.home + '/docs/notes-moved.txt',
        connected.home + '/readme.md',
        connected.home + '/notes - 副本.txt',
      ]) {
        try { await window.shellDeck.sftp.remove(sessionId, remotePath, false) } catch { /* not present */ }
      }
      await window.shellDeck.sftp.close(sessionId)
    })

    await page.evaluate(async () => {
      for (const host of ['192.168.200.4', '10.6.80.71', '2.2.2.2', '172.16.0.9', 'example-host']) {
        await window.shellDeck.servers.save({ name: `排序-${host}`, host, port: 22, username: 'u', password: 'p', authType: 'password' })
      }
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload())
    await page.waitForTimeout(800)
    await page.waitForFunction(() => document.querySelectorAll('.ssh-serverhost').length === 6, null, { timeout: 10000 })
    const hosts = await page.locator('.ssh-serverhost').allTextContents()
    const expected = ['2.2.2.2', '10.6.80.71', '127.0.0.1', '172.16.0.9', '192.168.200.4', 'example-host']
    if (JSON.stringify(hosts) !== JSON.stringify(expected)) throw new Error('server IP sort wrong: ' + JSON.stringify(hosts))
    log('server IP ascending sort ok', hosts.join(','))
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
