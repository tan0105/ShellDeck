const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const projectRoot = path.join(__dirname, '..')
const buildDir = path.join(projectRoot, '..', 'ShellDeck-build', 'win-unpacked')
const stagingDir = path.join(projectRoot, '..', 'ShellDeck-build', 'ShellDeck-staging')
const targetDir = path.join(projectRoot, 'release', 'ShellDeck')
const targetRuntime = path.join(targetDir, 'runtime')
const launcherSource = path.join(__dirname, 'launcher', 'ShellDeckLauncher.cs')
const icon = path.join(projectRoot, 'resources', 'icon.ico')
const innerExe = path.join(buildDir, 'ShellDeck.exe')

function show(message) {
  console.log(message)
}
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function copyTree(source, target, relative = '', skip = new Set()) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to, nextRelative, skip)
      continue
    }
    if (!entry.isFile() || skip.has(nextRelative)) continue
    if (fs.existsSync(to)) {
      const sourceStat = fs.statSync(from)
      const targetStat = fs.statSync(to)
      if (sourceStat.size === targetStat.size && hash(from) === hash(to)) continue
    }
    try {
      fs.copyFileSync(from, to)
    } catch (error) {
      if (error.code === 'EBUSY' && nextRelative === 'ShellDeckRuntime.exe' && fs.statSync(from).size === fs.statSync(to).size) {
        show('ShellDeckRuntime.exe 正在运行且大小一致，跳过运行时 exe，仅更新 app.asar')
        continue
      }
      throw new Error(`文件被占用，无法更新：${nextRelative}（${error.code}）。请退出正在运行的 ShellDeck 后重试。`)
    }
  }
}
function copyLauncher(source, target) {
  fs.copyFileSync(source, target)
}
function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error('未找到 .NET Framework csc.exe，无法生成入口启动器')
}
function isRunning() {
  try {
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ShellDeckRuntime.exe'], { encoding: 'utf8' })
    return output.includes('ShellDeckRuntime.exe')
  } catch {
    return false
  }
}
function canReplace(targetFile) {
  const probe = targetFile + '.locktest'
  try {
    fs.renameSync(targetFile, probe)
    fs.renameSync(probe, targetFile)
    return true
  } catch {
    try { if (fs.existsSync(probe)) fs.renameSync(probe, targetFile) } catch { /* Leave probe for diagnosis. */ }
    return false
  }
}
function overwriteInPlace(targetFile, sourceFile) {
  const buffer = fs.readFileSync(sourceFile)
  const fd = fs.openSync(targetFile, 'r+')
  try {
    fs.ftruncateSync(fd, 0)
    let offset = 0
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash(targetFile) === hash(sourceFile)
}

if (!fs.existsSync(innerExe)) {
  console.error('未找到打包输出:', innerExe)
  console.error('请先运行 electron-builder --win dir')
  process.exit(1)
}
if (isRunning()) {
  show('检测到 ShellDeck 正在运行：app.asar 将原地更新，完成后请重启程序')
}

show('组装暂存目录...')
fs.rmSync(stagingDir, { recursive: true, force: true })
fs.mkdirSync(stagingDir, { recursive: true })
copyTree(buildDir, path.join(stagingDir, 'runtime'))
fs.renameSync(path.join(stagingDir, 'runtime', 'ShellDeck.exe'), path.join(stagingDir, 'runtime', 'ShellDeckRuntime.exe'))

const stagingLauncher = path.join(stagingDir, 'ShellDeck.exe')
show('编译入口启动器...')
const csc = findCsc()
execFileSync(csc, [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  `/win32icon:${icon}`,
  `/out:${stagingLauncher}`,
  `/r:${path.join(path.dirname(csc), 'System.Windows.Forms.dll')}`,
  launcherSource,
], { stdio: 'inherit' })

show('同步到 release...')
fs.mkdirSync(targetDir, { recursive: true })
fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true })

const stagingRuntime = path.join(stagingDir, 'runtime')
const targetAsar = path.join(targetRuntime, 'resources', 'app.asar')
const stagingAsar = path.join(stagingRuntime, 'resources', 'app.asar')
const targetDefaultAsar = path.join(targetRuntime, 'resources', 'default_app.asar')
const stagingDefaultAsar = path.join(stagingRuntime, 'resources', 'default_app.asar')

if (!fs.existsSync(targetRuntime)) {
  copyTree(stagingRuntime, targetRuntime)
  copyLauncher(stagingLauncher, path.join(targetDir, 'ShellDeck.exe'))
  fs.rmSync(stagingDir, { recursive: true, force: true })
  show('完成:', targetDir)
  process.exit(0)
}

const locked = !canReplace(targetAsar)
if (locked) {
  const appSame = fs.existsSync(targetAsar) && hash(targetAsar) === hash(stagingAsar)
  const defaultExists = fs.existsSync(targetDefaultAsar)
  const defaultSame = !defaultExists || hash(targetDefaultAsar) === hash(stagingDefaultAsar)
  if (!appSame) {
    show('app.asar 被占用，尝试原地更新 asar 内容')
    if (!overwriteInPlace(targetAsar, stagingAsar)) {
      console.error('app.asar 原地更新失败，已保留旧版本，未修改 release。')
      console.error('新构建暂存在:', stagingDir)
      process.exit(2)
    }
  }
  if (defaultExists && !defaultSame) {
    if (!overwriteInPlace(targetDefaultAsar, stagingDefaultAsar)) {
      console.error('default_app.asar 原地更新失败，已保留旧版本，未修改 release。')
      console.error('新构建暂存在:', stagingDir)
      process.exit(2)
    }
  }
  show(appSame && defaultSame ? 'asar 未变化，仅同步其余文件' : 'asar 已原地更新，同步其余文件')
  copyTree(stagingRuntime, targetRuntime, '', new Set(['resources/app.asar', 'resources/default_app.asar']))
  copyLauncher(stagingLauncher, path.join(targetDir, 'ShellDeck.exe'))
  fs.rmSync(stagingDir, { recursive: true, force: true })
  show('完成（asar 原地更新）:', targetDir)
  if (isRunning()) show('请关闭并重新打开 ShellDeck，使新界面生效。')
  process.exit(0)
}

fs.rmSync(targetRuntime, { recursive: true, force: true })
copyTree(stagingRuntime, targetRuntime)
copyLauncher(stagingLauncher, path.join(targetDir, 'ShellDeck.exe'))
fs.rmSync(stagingDir, { recursive: true, force: true })
show('完成:', targetDir)
show('  入口 exe:', path.join(targetDir, 'ShellDeck.exe'))
show('  运行依赖:', targetRuntime)
show('  数据目录:', path.join(targetDir, 'data'))
