const path = require('node:path')
const fs = require('node:fs')
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, clipboard,
} = require('electron')

const db = require('./db.cjs')
const settings = require('./settings.cjs')
const ssh = require('./ssh-manager.cjs')
const sftp = require('./sftp-manager.cjs')
const updater = require('./updater.cjs')

const APP_ID = 'com.shelldeck.desktop'
const isDev = !app.isPackaged
let mainWindow = null
let tray = null
let isQuitting = false
let saveTimer = null
let autoCheckTimer = null

const paths = settings.resolvePaths()

function resourcePath(name) {
  if (app.isPackaged) return path.join(process.resourcesPath, 'resources', name)
  return path.join(app.getAppPath(), 'resources', name)
}

function showWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.moveTop()
  try { app.focus({ steal: true }) } catch { /* Focus is best effort. */ }
}

function toast(message, kind = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:toast', { message, kind })
}

function writeStartMarker() {
  const arg = process.argv.find(value => value.startsWith('--update-start-marker='))
  if (!arg) return
  try {
    const target = arg.slice('--update-start-marker='.length)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({ pid: process.pid, version: app.getVersion(), at: Date.now() }))
  } catch { /* Update verification is best effort. */ }
}

function loadWindowState() {
  try {
    const raw = db.getSetting('windowState')
    if (!raw) return null
    const value = JSON.parse(raw)
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height)) return value
  } catch { /* Fall back to defaults. */ }
  return null
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getNormalBounds()
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }
    db.setSetting('windowState', JSON.stringify(state))
  } catch { /* Window may already be gone. */ }
}

function scheduleStateSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveWindowState, 600)
}

function createWindow() {
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width || 1440,
    height: saved?.height || 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'ShellDeck',
    backgroundColor: '#eef1f6',
    icon: resourcePath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  mainWindow.webContents.once('did-finish-load', writeStartMarker)
  mainWindow.once('ready-to-show', () => {
    if (process.env.SHELLDECK_START_HIDDEN === '1') return
    mainWindow.show()
  })

  mainWindow.on('resize', scheduleStateSave)
  mainWindow.on('move', scheduleStateSave)
  mainWindow.on('maximize', scheduleStateSave)
  mainWindow.on('unmaximize', scheduleStateSave)

  mainWindow.on('close', event => {
    saveWindowState()
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    if (process.env.SHELLDECK_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }
}

function createTray() {
  const image = nativeImage.createFromPath(resourcePath('tray.png'))
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip('ShellDeck')
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showWindow() },
    { label: '打开数据目录', click: () => shell.openPath(paths.dataDir) },
    { type: 'separator' },
    { label: '检查更新', click: async () => {
      showWindow()
      try { await updater.check({ manual: true }) } catch (error) { toast(error.message, 'error') }
    } },
    { type: 'separator' },
    { label: '退出', click: () => requestQuit(false) },
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showWindow())
}

async function requestQuit(force) {
  if (isQuitting) return true
  if (!force && (sftp.activeTransferCount() > 0 || ssh.activeCount() > 0)) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['取消', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      title: '退出 ShellDeck',
      message: '还有运行中的会话或传输任务，确定要退出吗？',
      detail: '退出后所有终端、文件会话和进行中的上传/下载都会中断。',
    })
    if (result.response !== 1) return false
  }
  isQuitting = true
  saveWindowState()
  app.quit()
  return true
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...args)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  })
}

function registerIpc() {
  handle('servers:list', () => db.listServers())
  handle('servers:save', (event, server) => db.saveServer(server))
  handle('servers:delete', (event, id) => db.deleteServer(id))
  handle('servers:import', (event, rows) => db.importServers(rows))

  handle('commands:list', () => db.listCommands())
  handle('commands:save', (event, command) => db.saveCommand(command))
  handle('commands:delete', (event, id) => db.deleteCommand(id))
  handle('commands:import', (event, rows) => db.importCommands(rows))

  handle('settings:get', (event, key) => db.getSetting(key))
  handle('settings:set', (event, key, value) => {
    db.setSetting(key, value)
    if (key === 'update.autoCheck') {
      if (String(value) === '0') clearTimeout(autoCheckTimer)
      else scheduleAutoUpdate(true)
    }
    if (['update.accelerator', 'update.acceleratorCustom', 'update.networkMode', 'update.proxy'].includes(key)) scheduleAutoUpdate(true)
    return true
  })

  handle('terminal:open', (event, payload) => ssh.open(event.sender, payload))
  handle('terminal:input', (event, sessionId, data) => ssh.input(sessionId, data))
  handle('terminal:resize', (event, sessionId, cols, rows) => ssh.resize(sessionId, cols, rows))
  handle('terminal:close', (event, sessionId) => ssh.close(sessionId, false))

  handle('sftp:connect', (event, payload) => sftp.connect(event.sender, payload))
  handle('sftp:close', (event, sessionId) => sftp.close(sessionId))
  handle('sftp:list', (event, sessionId, target) => sftp.list(sessionId, target))
  handle('sftp:read', (event, sessionId, target) => sftp.read(sessionId, target))
  handle('sftp:write', (event, sessionId, target, content) => sftp.write(sessionId, target, content))
  handle('sftp:copy', (event, sessionId, from, to, overwrite) => sftp.copy(sessionId, from, to, overwrite))
  handle('sftp:move', (event, sessionId, from, to, overwrite) => sftp.move(sessionId, from, to, overwrite))
  handle('sftp:mkdir', (event, sessionId, target) => sftp.mkdir(sessionId, target))
  handle('sftp:rename', (event, sessionId, from, to) => sftp.rename(sessionId, from, to))
  handle('sftp:remove', (event, sessionId, target, recursive) => sftp.remove(sessionId, target, recursive))
  handle('sftp:chmod', (event, sessionId, target, mode, recursive) => sftp.chmod(sessionId, target, mode, recursive))
  handle('sftp:inspectLocal', (event, localPaths) => sftp.inspectLocal(localPaths))
  handle('sftp:statMany', (event, sessionId, targetDir, pathsToCheck) => sftp.statMany(sessionId, targetDir, pathsToCheck))
  handle('sftp:upload', (event, payload) => sftp.upload(event.sender, payload))
  handle('sftp:download', async (event, payload) => {
    let savePath = payload.savePath
    if (!savePath) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '下载文件',
        defaultPath: path.join(app.getPath('downloads'), payload.defaultName || path.basename(payload.remotePath || 'download')),
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      savePath = result.filePath
    }
    const result = await sftp.download(event.sender, { ...payload, savePath })
    return { ...result, canceled: false }
  })
  handle('sftp:cancel', (event, transferId) => sftp.cancelTransfer(transferId))

  handle('dialog:pickFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })
  handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件夹',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handle('dialog:pickKey', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 SSH 私钥',
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    const stat = fs.statSync(file)
    if (stat.size > 1024 * 1024) throw new Error('私钥文件过大')
    return { name: path.basename(file), content: fs.readFileSync(file, 'utf8') }
  })
  handle('dialog:openExcel', async (event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择服务器 Excel',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    return { name: path.basename(file), data: fs.readFileSync(file).toString('base64') }
  })
  handle('dialog:saveExcel', async (event, { name, data, title }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: title || '导出服务器清单',
      defaultPath: path.join(app.getPath('downloads'), name || 'ShellDeck-servers.xlsx'),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, Buffer.from(data, 'base64'))
    return result.filePath
  })

  handle('app:info', () => {
    const launcher = path.join(path.dirname(paths.dataDir), 'ShellDeck.exe')
    return {
      version: app.getVersion(),
      dataDir: paths.dataDir,
      dbFile: paths.dbFile,
      packaged: app.isPackaged,
      folderMode: app.isPackaged
        && !process.env.PORTABLE_EXECUTABLE_FILE
        && fs.existsSync(launcher)
        && fs.existsSync(path.join(path.dirname(paths.dataDir), 'runtime')),
      launcher,
    }
  })
  handle('app:openDataDir', () => shell.openPath(paths.dataDir))
  handle('app:backupDb', () => db.backupDatabase())
  handle('app:restoreDb', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择数据库备份',
      defaultPath: paths.backupsDir,
      filters: [{ name: 'SQLite', extensions: ['db'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const info = db.restoreDatabase(result.filePaths[0])
    return info
  })
  handle('app:quit', (event, force) => requestQuit(Boolean(force)))

  handle('clipboard:write', (event, text) => { clipboard.writeText(String(text ?? '')); return true })
  handle('clipboard:read', () => clipboard.readText())

  handle('updater:state', () => updater.snapshot())
  handle('updater:check', async () => {
    try {
      return await updater.check({ manual: true })
    } catch (error) {
      throw new Error(error.message)
    }
  })
  handle('updater:download', () => updater.download())
  handle('updater:install', () => updater.install())
  handle('updater:cancel', () => updater.cancel())
  handle('updater:listSources', () => updater.listSources())
  handle('updater:addSource', (event, source) => updater.addSource(source))
  handle('updater:removeSource', (event, id) => updater.removeSource(id))

  handle('shell:openExternal', (event, url) => {
    if (!/^https:\/\//i.test(String(url))) throw new Error('只允许打开 HTTPS 链接')
    return shell.openExternal(String(url))
  })
}

function scheduleAutoUpdate(initial) {
  clearTimeout(autoCheckTimer)
  if (db.getSetting('update.autoCheck') === '0') return
  const delay = initial
    ? 5000 + Math.floor(Math.random() * 40000)
    : 24 * 60 * 60 * 1000 + Math.floor(Math.random() * 3600 * 1000)
  autoCheckTimer = setTimeout(async () => {
    if (db.getSetting('update.autoCheck') === '0') return
    if (updater.hasSources()) {
      try { await updater.check({ manual: false }) } catch { /* Background check stays quiet. */ }
    }
    scheduleAutoUpdate(false)
  }, delay)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    const problem = settings.prepareDataDir(paths)
    if (problem) {
      dialog.showErrorBox('无法启动 ShellDeck', problem + '\n\n请把程序放到可写目录，或用管理员权限运行。')
      app.quit()
      return
    }
    try {
      db.init(paths)
    } catch (error) {
      dialog.showErrorBox('数据库初始化失败', String(error.message || error))
      app.quit()
      return
    }
    Menu.setApplicationMenu(null)
    registerIpc()
    updater.init({
      paths,
      emit: state => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:state', state)
        if (tray) tray.setToolTip(`ShellDeck${state.status === 'available' ? ` · 可更新 ${state.version}` : ''}`)
      },
    })
    createWindow()
    createTray()
    scheduleAutoUpdate(true)
    app.on('activate', () => showWindow())
  })

  app.on('window-all-closed', () => { /* Keep running in the tray. */ })

  app.on('before-quit', () => {
    isQuitting = true
    clearTimeout(autoCheckTimer)
    saveWindowState()
    try { ssh.closeAll() } catch { /* Ignore shutdown errors. */ }
    try { sftp.closeAll() } catch { /* Ignore shutdown errors. */ }
    try { db.closeDatabase() } catch { /* Ignore shutdown errors. */ }
  })
}
