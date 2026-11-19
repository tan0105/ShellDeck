const path = require('node:path')
const { execFileSync } = require('node:child_process')

if (process.env.SHELLDECK_SKIP_ELECTRON_DOWNLOAD === '1') process.exit(0)

execFileSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' })
