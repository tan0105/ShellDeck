const fs = require('node:fs')
const path = require('node:path')

const modules = path.join(__dirname, '..', 'node_modules')

function remove(relative) {
  fs.rmSync(path.join(modules, relative), { recursive: true, force: true })
}

remove('better-sqlite3/deps')
remove('better-sqlite3/build')
remove('cpu-features')
remove('buildcheck')
remove('nan')
remove('ssh2/lib/protocol/crypto/build')

const prebuilds = path.join(modules, 'better-sqlite3', 'prebuilds')
if (fs.existsSync(prebuilds)) {
  for (const file of fs.readdirSync(prebuilds)) {
    if (file !== 'win32-x64.node') fs.rmSync(path.join(prebuilds, file), { force: true })
  }
}
