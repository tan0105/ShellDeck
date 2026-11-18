const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const version = arg('version')
const file = arg('file', path.join('release', 'ShellDeck', 'runtime', 'ShellDeckRuntime.exe'))
const url = arg('url', 'ShellDeck.exe')
const notes = arg('notes', '')
const outDir = arg('out', 'release')
const keyPath = arg('key', process.env.SHELLDECK_RELEASE_KEY || path.join('.release-keys', 'private.pem'))

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('usage: npm run release -- --version 0.2.0 --file release/ShellDeck.exe --url https://.../ShellDeck.exe --notes "更新说明"')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error('installer not found:', file)
  process.exit(1)
}
if (!fs.existsSync(keyPath)) {
  console.error('private key not found:', keyPath)
  process.exit(1)
}

const bytes = fs.readFileSync(file)
const manifest = {
  schemaVersion: 1,
  appId: 'com.shelldeck.desktop',
  channel: 'stable',
  version,
  publishedAt: new Date().toISOString(),
  minSupportedVersion: '0.0.1',
  notes,
  assets: {
    'win-x64': {
      url,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  },
}
fs.mkdirSync(outDir, { recursive: true })
const manifestPath = path.join(outDir, 'release.json')
const raw = Buffer.from(JSON.stringify(manifest, null, 2))
fs.writeFileSync(manifestPath, raw)
const signature = crypto.sign(null, raw, fs.readFileSync(keyPath))
fs.writeFileSync(manifestPath + '.sig', signature.toString('base64'))
console.log('manifest:', manifestPath)
console.log('signature:', manifestPath + '.sig')
console.log('sha256:', manifest.assets['win-x64'].sha256)
console.log('size:', manifest.assets['win-x64'].size)
