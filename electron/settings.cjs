const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const PROBE = '.write-probe'

function resolveDataDir() {
  if (process.env.SHELLDECK_DATA_DIR) return process.env.SHELLDECK_DATA_DIR
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
  if (app.isPackaged) return path.join(path.dirname(app.getPath('exe')), 'data')
  return path.join(__dirname, '..', 'data')
}

function resolvePaths() {
  const dataDir = resolveDataDir()
  const paths = {
    dataDir,
    dbFile: path.join(dataDir, 'ssh.db'),
    backupsDir: path.join(dataDir, 'backups'),
    updatesDir: path.join(dataDir, 'updates'),
    logsDir: path.join(dataDir, 'logs'),
  }
  return paths
}

function ensureWritable(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, PROBE)
  fs.writeFileSync(probe, 'ok')
  fs.unlinkSync(probe)
}

function prepareDataDir(paths) {
  try {
    ensureWritable(paths.dataDir)
    fs.mkdirSync(paths.backupsDir, { recursive: true })
    fs.mkdirSync(paths.updatesDir, { recursive: true })
    fs.mkdirSync(paths.logsDir, { recursive: true })
    return null
  } catch (error) {
    return `数据目录不可写：${paths.dataDir}\n${error.message}`
  }
}

module.exports = { resolvePaths, prepareDataDir }
