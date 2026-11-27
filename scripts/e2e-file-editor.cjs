const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Server, utils } = require('ssh2')
const { OPEN_MODE, Stats, STATUS_CODE } = require('ssh2/lib/protocol/SFTP.js')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `shelldeck-editor-${process.pid}-`))
const remoteRoot = path.join(tempDir, 'remote')
const dataDir = path.join(tempDir, 'data')
const userDataDir = path.join(tempDir, 'userdata')
const screenshotDir = path.join(tempDir, 'screenshots')
fs.mkdirSync(remoteRoot, { recursive: true })
fs.mkdirSync(screenshotDir, { recursive: true })

const files = {
  'empty.conf': '',
  'single.conf': 'single line\n',
  'nginx.conf': Array.from({ length: 155 }, (_, index) => {
    if (index === 0) return '# nginx regression fixture'
    if (index === 76) return `long_directive_${index} = "${'value-'.repeat(45)}";`
    return index % 9 === 0 ? `server_${index} {` : index % 9 === 4 ? '}' : `setting_${index} = ${index};`
  }).join('\n') + '\n',
  'long-lines.conf': Array.from({ length: 120 }, (_, index) => `line_${String(index + 1).padStart(3, '0')}=${'x'.repeat(700)}`).join('\n') + '\n',
  'large.conf': Array.from({ length: 3000 }, (_, index) => `large_line_${String(index + 1).padStart(4, '0')} = ${'abcdefghij'.repeat(12)};`).join('\n') + '\n',
}
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(remoteRoot, name), content, 'utf8')

function log(step, value = '') {
  console.log(`[editor] ${step}${value ? ': ' + value : ''}`)
}

function localPath(remotePath) {
  const normalized = path.posix.normalize(String(remotePath || '/'))
  const resolved = path.resolve(remoteRoot, `.${normalized}`)
  if (resolved !== remoteRoot && !resolved.startsWith(remoteRoot + path.sep)) throw new Error('path outside test root')
  return resolved
}

function attrsFor(filePath, useLstat = false) {
  const stat = useLstat ? fs.lstatSync(filePath) : fs.statSync(filePath)
  return new Stats({ mode: stat.mode, size: stat.size, uid: 0, gid: 0, atime: stat.atimeMs / 1000, mtime: stat.mtimeMs / 1000 })
}

function failRequest(sftp, id, error) {
  const code = error && error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE
  sftp.status(id, code, error && error.message ? error.message : 'SFTP failure')
}

function fsFlags(flags) {
  if ((flags & OPEN_MODE.TRUNC) && (flags & OPEN_MODE.APPEND)) return 'a'
  if (flags & OPEN_MODE.APPEND) return 'a'
  if (flags & OPEN_MODE.TRUNC) return 'w'
  if ((flags & OPEN_MODE.READ) && (flags & OPEN_MODE.WRITE)) return 'r+'
  if (flags & OPEN_MODE.WRITE) return 'r+'
  return 'r'
}

function attachSftp(sftp) {
  const handles = new Map()
  let nextHandle = 1
  const addHandle = value => {
    const id = Buffer.from(String(nextHandle++))
    handles.set(id.toString('hex'), value)
    return id
  }
  const getHandle = id => handles.get(Buffer.from(id).toString('hex'))

  sftp.on('OPEN', (id, remotePath, flags) => {
    try {
      const target = localPath(remotePath)
      const mode = fsFlags(flags)
      const fd = fs.openSync(target, mode, 0o644)
      sftp.handle(id, addHandle({ fd, path: target }))
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('CLOSE', (id, handle) => {
    const item = getHandle(handle)
    try {
      if (!item) throw new Error('invalid handle')
      if (item.fd !== undefined && item.fd !== null) fs.closeSync(item.fd)
      handles.delete(Buffer.from(handle).toString('hex'))
      sftp.status(id, STATUS_CODE.OK)
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('READ', (id, handle, offset, length) => {
    try {
      const item = getHandle(handle)
      if (!item) throw new Error('invalid handle')
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(item.fd, buffer, 0, length, Number(offset))
      if (!read) sftp.status(id, STATUS_CODE.EOF)
      else sftp.data(id, buffer.subarray(0, read))
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('WRITE', (id, handle, offset, data) => {
    try {
      const item = getHandle(handle)
      if (!item) throw new Error('invalid handle')
      fs.writeSync(item.fd, data, 0, data.length, Number(offset))
      sftp.status(id, STATUS_CODE.OK)
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('FSTAT', (id, handle) => {
    try {
      const item = getHandle(handle)
      if (!item) throw new Error('invalid handle')
      sftp.attrs(id, attrsFor(item.path))
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('STAT', (id, remotePath) => {
    try { sftp.attrs(id, attrsFor(localPath(remotePath))) } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('LSTAT', (id, remotePath) => {
    try { sftp.attrs(id, attrsFor(localPath(remotePath), true)) } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('REALPATH', (id, remotePath) => {
    try {
      const normalized = path.posix.normalize(String(remotePath || '/'))
      sftp.name(id, [{ filename: normalized, attrs: attrsFor(localPath(normalized)) }])
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('OPENDIR', (id, remotePath) => {
    try { sftp.handle(id, addHandle({ dir: localPath(remotePath), sent: false })) } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('READDIR', (id, handle) => {
    try {
      const item = getHandle(handle)
      if (!item || !item.dir) throw new Error('invalid handle')
      if (item.sent) { sftp.status(id, STATUS_CODE.EOF); return }
      item.sent = true
      const entries = fs.readdirSync(item.dir, { withFileTypes: true }).map(entry => ({
        filename: entry.name,
        attrs: attrsFor(path.join(item.dir, entry.name), entry.isSymbolicLink()),
      }))
      sftp.name(id, entries)
    } catch (error) { failRequest(sftp, id, error) }
  })
  sftp.on('error', () => {})
}

async function startSftpServer() {
  const hostKey = utils.generateKeyPairSync('rsa', { bits: 2048 })
  const clients = new Set()
  const server = new Server({ hostKeys: [hostKey.private] }, connection => {
    clients.add(connection)
    connection.on('close', () => clients.delete(connection))
    connection.on('error', () => {})
    connection.on('authentication', context => {
      if (context.method === 'password' && context.username === 'tester' && context.password === 'testpw') context.accept()
      else context.reject(['password'])
    })
    connection.on('ready', () => {
      connection.on('session', accept => {
        const session = accept()
        session.on('sftp', acceptSftp => attachSftp(acceptSftp()))
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: async () => {
      for (const connection of clients) connection.end()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

async function setWindowContentSize(app, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(size.width, size.height)
    window.center()
  }, { width, height })
  await app.evaluate(async () => new Promise(resolve => setTimeout(resolve, 80)))
}

async function setTheme(page, dark) {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('theme-dark'))
  if (isDark !== dark) await page.locator('.ssh-topactions .theme-toggle').click()
  await page.waitForFunction(value => document.documentElement.classList.contains('theme-dark') === value, dark)
}

async function openEditor(page, name, expected) {
  const row = page.locator('.filetile tbody tr', { hasText: name }).first()
  await row.locator('.ssh-fileactions .ssh-link', { hasText: '编辑' }).click()
  await page.waitForSelector('.ssh-editor-dialog')
  await page.waitForFunction(value => {
    const textarea = document.querySelector('.ssh-editor-dialog .ssh-editor')
    const save = [...document.querySelectorAll('.ssh-editor-dialog .um-dialog-actions button')].find(button => button.textContent.includes('保存'))
    return textarea && textarea.value === value && save && !save.disabled
  }, expected, { timeout: 15000 })
  await page.waitForTimeout(120)
}

async function closeEditor(page) {
  await page.locator('.ssh-editor-dialog .um-dialog-actions button', { hasText: '取消' }).click()
  await page.waitForSelector('.ssh-editor-dialog', { state: 'detached' })
}

async function editorMetrics(page) {
  return page.evaluate(() => {
    const textarea = document.querySelector('.ssh-editor-dialog .ssh-editor')
    const gutter = document.querySelector('.ssh-editor-dialog .ssh-editor-lines')
    const shell = document.querySelector('.ssh-editor-dialog .ssh-editor-shell')
    const dialog = document.querySelector('.ssh-editor-dialog')
    const rect = element => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
    }
    const style = getComputedStyle(textarea)
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: rect(dialog),
      shell: rect(shell),
      textarea: rect(textarea),
      gutter: rect(gutter),
      textareaClientHeight: textarea.clientHeight,
      textareaOffsetHeight: textarea.offsetHeight,
      textareaScrollHeight: textarea.scrollHeight,
      textareaClientWidth: textarea.clientWidth,
      textareaScrollWidth: textarea.scrollWidth,
      gutterClientHeight: gutter.clientHeight,
      gutterOffsetHeight: gutter.offsetHeight,
      scrollTop: textarea.scrollTop,
      scrollLeft: textarea.scrollLeft,
      gutterScrollTop: gutter.scrollTop,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      valueLength: textarea.value.length,
      lineCount: textarea.value.split('\n').length,
      displayedLineCount: Number([...document.querySelectorAll('.ssh-editor-tools span')].map(node => node.textContent).find(text => text.includes('行'))?.match(/\d+/)?.[0] || 0),
      firstLine: textarea.value.split('\n')[0],
      lineHeight: parseFloat(style.lineHeight),
      fontSize: parseFloat(style.fontSize),
      paddingTop: parseFloat(style.paddingTop),
      gutterPaddingTop: parseFloat(getComputedStyle(gutter).paddingTop),
      gutterLineHeight: parseFloat(getComputedStyle(gutter).lineHeight),
      color: style.color,
      background: style.backgroundColor,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    }
  })
}

function assertEditorLayout(metrics, context, expectedLines) {
  const failures = []
  const check = (condition, message) => { if (!condition) failures.push(message) }
  check(metrics.textareaOffsetHeight >= 300, `textarea too short: ${metrics.textareaOffsetHeight}`)
  check(Math.abs(metrics.textareaOffsetHeight - metrics.gutterOffsetHeight) <= 2, `textarea/gutter height mismatch: ${metrics.textareaOffsetHeight}/${metrics.gutterOffsetHeight}`)
  check(metrics.textareaClientHeight >= 280, `textarea visible height too small: ${metrics.textareaClientHeight}`)
  check(metrics.textarea.width >= 400, `textarea too narrow: ${metrics.textarea.width}`)
  check(metrics.scrollTop === 0, `vertical scroll did not reset: ${metrics.scrollTop}`)
  check(metrics.scrollLeft === 0, `horizontal scroll did not reset: ${metrics.scrollLeft}`)
  check(metrics.selectionStart === 0 && metrics.selectionEnd === 0, `caret not at start: ${metrics.selectionStart}/${metrics.selectionEnd}`)
  check(metrics.gutterScrollTop === 0, `gutter scroll did not reset: ${metrics.gutterScrollTop}`)
  check(metrics.lineCount === expectedLines, `line count mismatch: ${metrics.lineCount}/${expectedLines}`)
  check(metrics.displayedLineCount === expectedLines, `displayed line count mismatch: ${metrics.displayedLineCount}/${expectedLines}`)
  check(metrics.dialog.x >= -1 && metrics.dialog.y >= -1 && metrics.dialog.right <= metrics.viewport.width + 1 && metrics.dialog.bottom <= metrics.viewport.height + 1, 'dialog is outside viewport')
  check(metrics.textarea.x >= metrics.shell.x && metrics.textarea.right <= metrics.shell.right + 1 && metrics.textarea.y >= metrics.shell.y && metrics.textarea.bottom <= metrics.shell.bottom + 1, 'textarea is outside shell')
  check(metrics.pageOverflow <= 1, `page horizontal overflow: ${metrics.pageOverflow}`)
  check(metrics.lineHeight > 0 && metrics.fontSize >= 13, `invalid editor typography: ${metrics.fontSize}/${metrics.lineHeight}`)
  check(Math.abs(metrics.paddingTop - metrics.gutterPaddingTop) <= 0.1, `top padding mismatch: ${metrics.paddingTop}/${metrics.gutterPaddingTop}`)
  check(Math.abs(metrics.lineHeight - metrics.gutterLineHeight) <= 0.1, `line height mismatch: ${metrics.lineHeight}/${metrics.gutterLineHeight}`)
  if (failures.length) throw new Error(`${context}: ${failures.join('; ')}`)
}

async function main() {
  const sftpServer = await startSftpServer()
  const packagedExe = process.env.SHELLDECK_EDITOR_EXE || ''
  const useDev = process.env.SHELLDECK_EDITOR_DEV === '1'
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const executablePath = packagedExe || (useDev ? electronExe : path.join(root, 'release', 'ShellDeck', 'runtime', 'ShellDeckRuntime.exe'))
  const isPackaged = !useDev
  if (!fs.existsSync(executablePath)) throw new Error(`test executable missing: ${executablePath}; run npm run dist first`)
  let app
  try {
    app = await electron.launch({
      executablePath,
      args: isPackaged
        ? ['--no-sandbox', `--user-data-dir=${userDataDir}`]
        : ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
      cwd: isPackaged ? path.dirname(executablePath) : root,
      env: { ...process.env, SHELLDECK_DATA_DIR: dataDir, SHELLDECK_START_HIDDEN: '0' },
      timeout: 60000,
    })
    const page = await app.firstWindow()
    const rendererErrors = []
    page.on('pageerror', error => rendererErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') rendererErrors.push(message.text())
    })
    await page.waitForSelector('.ssh-workspace', { timeout: 25000 })
    await page.evaluate(() => window.shellDeck.settings.set('update.autoCheck', '0'))
    await setWindowContentSize(app, 1440, 900)
    await setTheme(page, false)

    await page.locator('button.ssh-newserver').click()
    const inputs = page.locator('.sd-dialog input')
    await inputs.nth(0).fill('编辑器回归测试机')
    await inputs.nth(1).fill('127.0.0.1')
    await inputs.nth(2).fill(String(sftpServer.port))
    await inputs.nth(3).fill('tester')
    await inputs.nth(4).fill('testpw')
    await page.locator('.sd-dialog .um-primary').click()
    await page.waitForSelector('.ssh-serverrow')
    await page.locator('.ssh-serverrow').first().click({ button: 'right' })
    await page.locator('.server-menu button', { hasText: '打开文件' }).click()
    await page.waitForSelector('.filetile')
    await page.waitForFunction(() => document.querySelector('.filetile .ssh-filetable')?.textContent.includes('large.conf'), null, { timeout: 20000 })

    const cases = [
      { theme: 'light', width: 1440, height: 900, file: 'nginx.conf' },
      { theme: 'dark', width: 1880, height: 1000, file: 'nginx.conf' },
      { theme: 'light', width: 1024, height: 680, file: 'empty.conf' },
      { theme: 'light', width: 1024, height: 680, file: 'single.conf' },
      { theme: 'dark', width: 1024, height: 680, file: 'long-lines.conf' },
      { theme: 'light', width: 1880, height: 1000, file: 'large.conf' },
    ]
    const summary = []
    for (const testCase of cases) {
      await setTheme(page, testCase.theme === 'dark')
      await setWindowContentSize(app, testCase.width, testCase.height)
      const expected = files[testCase.file]
      await openEditor(page, testCase.file, expected)
      const metrics = await editorMetrics(page)
      const context = `${testCase.theme}/${testCase.width}x${testCase.height}/${testCase.file}`
      assertEditorLayout(metrics, context, expected.split('\n').length)
      if (testCase.file === 'nginx.conf') {
        await page.locator('.ssh-editor').evaluate(textarea => {
          textarea.scrollTop = 500
          textarea.scrollLeft = 100
          textarea.dispatchEvent(new Event('scroll'))
        })
        const manualScroll = await editorMetrics(page)
        assert(manualScroll.scrollTop > 0 && manualScroll.scrollLeft > 0, 'manual scroll fixture did not scroll')
        assert(Math.abs(manualScroll.gutterScrollTop - manualScroll.scrollTop) <= 1, 'gutter did not follow manual scroll')
        await page.locator('.ssh-editor-tools input').fill('120')
        await page.locator('.ssh-editor-tools input').press('Enter')
        await page.waitForFunction(() => document.querySelector('.ssh-editor').scrollTop > 0)
        const jumped = await editorMetrics(page)
        assert(jumped.scrollTop > 0, 'line jump did not scroll the editor')
        assert(Math.abs(jumped.gutterScrollTop - jumped.scrollTop) <= 1, 'gutter did not follow line jump')
        await closeEditor(page)
        await openEditor(page, testCase.file, expected)
        const reopened = await editorMetrics(page)
        assertEditorLayout(reopened, `${context}/reopen`, expected.split('\n').length)
        summary.push({ context: context + '/reopen', textarea: reopened.textareaOffsetHeight, gutter: reopened.gutterOffsetHeight, scrollTop: reopened.scrollTop, scrollLeft: reopened.scrollLeft })
      } else {
        summary.push({ context, textarea: metrics.textareaOffsetHeight, gutter: metrics.gutterOffsetHeight, scrollTop: metrics.scrollTop, scrollLeft: metrics.scrollLeft })
      }
      if (testCase.file === 'long-lines.conf') assert(metrics.textareaScrollWidth > metrics.textareaClientWidth, 'long-line fixture did not create horizontal scrolling')
      if (testCase.file === 'large.conf') assert(metrics.textareaScrollHeight > metrics.textareaClientHeight, 'large fixture did not create vertical scrolling')
      if ((testCase.file === 'nginx.conf' && testCase.theme === 'light') || testCase.file === 'long-lines.conf' || testCase.file === 'large.conf') {
        await page.screenshot({ path: path.join(screenshotDir, `${testCase.theme}-${testCase.width}x${testCase.height}-${testCase.file}.png`) })
      }
      await closeEditor(page)
    }

    await setTheme(page, false)
    await setWindowContentSize(app, 1440, 900)
    await openEditor(page, 'long-lines.conf', files['long-lines.conf'])
    const beforeResize = await editorMetrics(page)
    await setWindowContentSize(app, 1880, 1000)
    const afterResize = await editorMetrics(page)
    assert(afterResize.textareaOffsetHeight > beforeResize.textareaOffsetHeight, 'editor height did not grow after window resize')
    assertEditorLayout(afterResize, 'resize/1440x900-to-1880x1000', files['long-lines.conf'].split('\n').length)
    await closeEditor(page)
    log('open-editor resize ok', `${beforeResize.textareaOffsetHeight}->${afterResize.textareaOffsetHeight}`)

    const savedContent = '// editor regression save check\n' + files['nginx.conf']
    await openEditor(page, 'nginx.conf', files['nginx.conf'])
    await page.locator('.ssh-editor').fill(savedContent)
    await page.locator('.ssh-editor-dialog .um-dialog-actions .um-primary').click()
    await page.waitForSelector('.ssh-editor-dialog', { state: 'detached', timeout: 15000 })
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'nginx.conf'), 'utf8'), savedContent, 'saved SFTP content mismatch')
    await openEditor(page, 'nginx.conf', savedContent)
    const savedMetrics = await editorMetrics(page)
    assertEditorLayout(savedMetrics, 'save-and-reopen', savedContent.split('\n').length)
    assert(savedMetrics.firstLine.startsWith('// editor regression save check'), 'saved first line was not shown')
    await closeEditor(page)

    if (rendererErrors.length) throw new Error('renderer errors: ' + rendererErrors.join(' | '))
    log('matrix ok')
    for (const item of summary) log('geometry', JSON.stringify(item))
    log('line jump, reopen reset, resize and save roundtrip ok')
    log('screenshots', screenshotDir)
  } finally {
    if (app) await app.close().catch(() => {})
    await sftpServer.close().catch(() => {})
    if (process.env.SHELLDECK_EDITOR_KEEP_TEMP === '1') log('temp retained', tempDir)
    else fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error('[editor] FAILED', error && error.stack ? error.stack : error)
  fs.rmSync(tempDir, { recursive: true, force: true })
  process.exit(1)
})
