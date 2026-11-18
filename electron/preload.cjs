const { contextBridge, ipcRenderer, webUtils } = require('electron')

const EVENT_CHANNELS = new Set([
  'terminal:data',
  'terminal:ready',
  'terminal:closed',
  'terminal:error',
  'transfer:progress',
  'transfer:done',
  'transfer:error',
  'updater:state',
  'app:toast',
])

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args)
  if (!result || result.ok !== true) throw new Error(result && result.error ? result.error : '操作失败')
  return result.data
}

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.has(channel)) throw new Error('不支持的事件：' + channel)
  const listener = (event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('shellDeck', {
  servers: {
    list: () => invoke('servers:list'),
    save: server => invoke('servers:save', server),
    remove: id => invoke('servers:delete', id),
    importMany: rows => invoke('servers:import', rows),
  },
  commands: {
    list: () => invoke('commands:list'),
    save: command => invoke('commands:save', command),
    remove: id => invoke('commands:delete', id),
  },
  settings: {
    get: key => invoke('settings:get', key),
    set: (key, value) => invoke('settings:set', key, value),
  },
  terminal: {
    open: payload => invoke('terminal:open', payload),
    input: (sessionId, data) => invoke('terminal:input', sessionId, data),
    resize: (sessionId, cols, rows) => invoke('terminal:resize', sessionId, cols, rows),
    close: sessionId => invoke('terminal:close', sessionId),
  },
  sftp: {
    connect: payload => invoke('sftp:connect', payload),
    close: sessionId => invoke('sftp:close', sessionId),
    list: (sessionId, target) => invoke('sftp:list', sessionId, target),
    read: (sessionId, target) => invoke('sftp:read', sessionId, target),
    write: (sessionId, target, content) => invoke('sftp:write', sessionId, target, content),
    copy: (sessionId, from, to, overwrite) => invoke('sftp:copy', sessionId, from, to, overwrite),
    move: (sessionId, from, to, overwrite) => invoke('sftp:move', sessionId, from, to, overwrite),
    mkdir: (sessionId, target) => invoke('sftp:mkdir', sessionId, target),
    rename: (sessionId, from, to) => invoke('sftp:rename', sessionId, from, to),
    remove: (sessionId, target, recursive) => invoke('sftp:remove', sessionId, target, recursive),
    chmod: (sessionId, target, mode, recursive) => invoke('sftp:chmod', sessionId, target, mode, recursive),
    inspectLocal: localPaths => invoke('sftp:inspectLocal', localPaths),
    statMany: (sessionId, targetDir, relativePaths) => invoke('sftp:statMany', sessionId, targetDir, relativePaths),
    upload: payload => invoke('sftp:upload', payload),
    download: payload => invoke('sftp:download', payload),
    cancel: transferId => invoke('sftp:cancel', transferId),
  },
  dialog: {
    pickFiles: () => invoke('dialog:pickFiles'),
    pickFolder: () => invoke('dialog:pickFolder'),
    pickKey: () => invoke('dialog:pickKey'),
    openExcel: () => invoke('dialog:openExcel'),
    saveExcel: payload => invoke('dialog:saveExcel', payload),
  },
  app: {
    info: () => invoke('app:info'),
    openDataDir: () => invoke('app:openDataDir'),
    backupDb: () => invoke('app:backupDb'),
    restoreDb: () => invoke('app:restoreDb'),
    quit: force => invoke('app:quit', Boolean(force)),
  },
  clipboard: {
    write: text => invoke('clipboard:write', text),
    read: () => invoke('clipboard:read'),
  },
  updater: {
    state: () => invoke('updater:state'),
    check: () => invoke('updater:check'),
    download: () => invoke('updater:download'),
    install: () => invoke('updater:install'),
    listSources: () => invoke('updater:listSources'),
    addSource: source => invoke('updater:addSource', source),
    removeSource: id => invoke('updater:removeSource', id),
  },
  openExternal: url => invoke('shell:openExternal', url),
  getPathForFile: file => webUtils.getPathForFile(file),
  on: subscribe,
})
