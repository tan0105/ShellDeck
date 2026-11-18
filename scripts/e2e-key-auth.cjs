const fs = require('node:fs')
const path = require('node:path')
const { Server, utils } = require('ssh2')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const dataDir = path.join(root, '.e2e-key-data')
const userDataDir = path.join(root, '.e2e-key-userdata')
const port = 12223

function log(step, value = '') {
  console.log(`[key] ${step}${value ? ': ' + value : ''}`)
}
async function waitText(page, selector, text, timeout = 20000) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text }, { timeout })
}

async function main() {
  const host = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const client = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const hostPem = host.private
  const clientPem = client.private
  const allowed = utils.parseKey(client.public)
  const allowedKey = Array.isArray(allowed) ? allowed[0] : allowed

  const server = new Server({ hostKeys: [hostPem] }, clientConn => {
    clientConn.on('authentication', ctx => {
      if (ctx.method === 'publickey' && ctx.username === 'tester') {
        console.log('[auth]', ctx.method, ctx.username, Boolean(ctx.signature), ctx.hashAlgo)
        if (!ctx.signature) return ctx.accept()
        try {
          if (allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) { console.log('[auth] verified'); return ctx.accept() }
          console.log('[auth] verify failed')
        } catch (error) { console.log('[auth] verify error', error.message) }
        return ctx.reject(['publickey'])
      }
      return ctx.reject(['publickey'])
    })
    clientConn.on('ready', () => {
      clientConn.on('session', accept => {
        const session = accept()
        session.on('pty', acceptPty => acceptPty && acceptPty())
        session.on('window-change', acceptWindow => acceptWindow && acceptWindow())
        session.on('shell', acceptShell => {
          const stream = acceptShell()
          stream.write('key-shell ready\r\n')
          stream.on('data', data => stream.write(data))
        })
        session.on('exec', acceptExec => {
          const stream = acceptExec()
          stream.exit(0)
          stream.end()
        })
      })
    })
    clientConn.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  log('ssh2 key server listening', String(port))

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
    await page.locator('.ssh-topactions .theme-toggle').click()
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'))
    await page.locator('button.ssh-newserver').click()
    await page.waitForSelector('.sd-dialog')
    const dialogMetrics = await page.evaluate(() => {
      const dialog = document.querySelector('.sd-dialog')
      const row = document.querySelector('.sd-row')
      const label = row.querySelector('span')
      const input = row.querySelector('input')
      const box = dialog.getBoundingClientRect()
      return {
        width: Math.round(box.width),
        fieldFont: parseFloat(getComputedStyle(row).fontSize),
        rowGap: parseFloat(getComputedStyle(row.parentElement).gap),
        inputHeight: Math.round(input.getBoundingClientRect().height),
        sameLine: Math.abs(label.getBoundingClientRect().top - input.getBoundingClientRect().top) < 10,
        aligned: new Set([...document.querySelectorAll('.sd-form .sd-row > input')].slice(0, 5).map(item => Math.round(item.getBoundingClientRect().left))).size === 1,
        checkboxAligned: Math.abs(document.querySelector('.sd-checkbox input').getBoundingClientRect().left - document.querySelector('.sd-form .sd-row > input').getBoundingClientRect().left) < 2,
        passwordType: document.querySelectorAll('.sd-dialog input')[4]?.type || '',
      }
    })
    if (dialogMetrics.width > 520) throw new Error('server dialog is too wide: ' + dialogMetrics.width)
    if (dialogMetrics.fieldFont > 13) throw new Error('server dialog field font too large: ' + dialogMetrics.fieldFont)
    if (dialogMetrics.rowGap > 5) throw new Error('server dialog row gap too large: ' + dialogMetrics.rowGap)
    if (!dialogMetrics.sameLine) throw new Error('label and input are not on the same line')
    if (!dialogMetrics.aligned) throw new Error('input columns are not aligned')
    if (!dialogMetrics.checkboxAligned) throw new Error('checkbox is not aligned with inputs')
    if (dialogMetrics.inputHeight > 30) throw new Error('server dialog input too tall: ' + dialogMetrics.inputHeight)
    if (dialogMetrics.passwordType !== 'text') throw new Error('password is not plaintext: ' + dialogMetrics.passwordType)
    log('compact dialog and plaintext password ok', JSON.stringify(dialogMetrics))

    const inputs = page.locator('.sd-dialog input')
    await inputs.nth(0).fill('密钥测试机')
    await inputs.nth(1).fill('127.0.0.1')
    await inputs.nth(2).fill(String(port))
    await inputs.nth(3).fill('tester')
    await page.locator('.sd-tagadd input').fill('密钥测试')
    await page.locator('.sd-tagadd button').click()
    const activeTag = await page.locator('.sd-tag.active').textContent()
    if (!activeTag.includes('密钥测试')) throw new Error('quick tag add failed')
    await page.locator('.sd-auth button', { hasText: '密钥' }).click()
    await page.locator('.sd-key').fill(clientPem)
    const darkButtons = await page.evaluate(() => ({
      keyFile: getComputedStyle(document.querySelector('.sd-keyactions .ssh-softbtn')).backgroundColor,
      addTag: getComputedStyle(document.querySelector('.sd-tagadd .ssh-softbtn')).backgroundColor,
    }))
    if (darkButtons.keyFile === 'rgb(255, 255, 255)' || darkButtons.addTag === 'rgb(255, 255, 255)') {
      throw new Error('dark editor buttons are still white: ' + JSON.stringify(darkButtons))
    }
    await page.screenshot({ path: path.join(root, 'screenshots', '12-key-editor.png') })
    await page.locator('.sd-dialog .um-primary').click()
    await page.waitForSelector('.ssh-serverrow', { timeout: 10000 })
    const saved = await page.evaluate(() => window.shellDeck.servers.list())
    if (saved[0].authType !== 'key' || !saved[0].privateKey.includes('BEGIN')) throw new Error('key fields not saved')
    if (!saved[0].tags.includes('密钥测试')) throw new Error('tags not saved')
    log('key auth server saved')

    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开终端' }).click()
    await page.waitForSelector('.termtile', { timeout: 10000 })
    try {
      await page.waitForFunction(() => !document.querySelector('.termtile .pv-terminal-mask'), null, { timeout: 20000 })
    } catch (error) {
      const mask = await page.locator('.termtile .pv-terminal-mask').textContent().catch(() => '(no mask)')
      await page.screenshot({ path: path.join(root, 'screenshots', 'key-auth-fail.png') })
      throw new Error('key terminal failed: ' + mask)
    }
    await waitText(page, '.termtile .xterm-rows', 'key-shell ready')
    log('ssh key authentication ok')

    await page.locator('button.ssh-newserver').click()
    await page.waitForSelector('.sd-dialog')
    const knownTag = page.locator('.sd-tag', { hasText: '密钥测试' }).first()
    if (!(await knownTag.count())) throw new Error('known tag not offered')
    await knownTag.click()
    const knownActive = await page.locator('.sd-tag.active').filter({ hasText: '密钥测试' }).count()
    if (!knownActive) throw new Error('known tag selection failed')
    await page.locator('.sd-dialog .um-close').click()
    log('known tag selection ok')
  } finally {
    await app.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
  }
}

main().then(() => {
  log('done')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(0)
}).catch(error => {
  console.error('[key] FAILED', error && error.stack ? error.stack : error)
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  process.exit(1)
})
