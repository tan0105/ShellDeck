const fs = require('node:fs')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')

const root = path.join(__dirname, '..')
const dataDir = path.join(root, '.dev-data')

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true })
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.', '--no-sandbox'],
    cwd: root,
    env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173', SHELLDECK_DATA_DIR: dataDir },
    timeout: 60000,
  })
  try {
    const page = await app.firstWindow()
    const errors = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForSelector('.ssh-workspace', { timeout: 25000 })
    const loadedFromVite = await page.evaluate(() => location.href)
    if (!loadedFromVite.startsWith('http://127.0.0.1:5173')) throw new Error('dev page not served by Vite: ' + loadedFromVite)
    await page.waitForTimeout(1500)
    if (errors.length) throw new Error('renderer errors: ' + errors.join(' | '))
    console.log('[dev] ok:', loadedFromVite)
  } finally {
    await app.close().catch(() => {})
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error('[dev] FAILED', error.message)
  process.exit(1)
})
