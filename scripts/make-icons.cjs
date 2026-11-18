const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function createPng(size, options) {
  const { background, glyph, rounded } = options
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const radius = rounded ? size * 0.22 : 0
  const lineWidth = Math.max(1.5, size * 0.065)
  const a = { x: size * 0.31, y: size * 0.29 }
  const b = { x: size * 0.51, y: size * 0.5 }
  const c = { x: size * 0.31, y: size * 0.71 }
  const d = { x: size * 0.56, y: size * 0.71 }
  const e = { x: size * 0.78, y: size * 0.71 }

  const distanceToSegment = (px, py, p1, p2) => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const length = dx * dx + dy * dy
    const t = length ? Math.max(0, Math.min(1, ((px - p1.x) * dx + (py - p1.y) * dy) / length)) : 0
    const x = p1.x + t * dx
    const y = p1.y + t * dy
    return Math.hypot(px - x, py - y)
  }

  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x += 1) {
      const offset = y * (size * 4 + 1) + 1 + x * 4
      let inside = true
      if (rounded) {
        const cx = Math.max(radius, Math.min(size - radius, x + 0.5))
        const cy = Math.max(radius, Math.min(size - radius, y + 0.5))
        inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius
      }
      if (!inside) {
        raw[offset + 3] = 0
        continue
      }
      let r = background[0]
      let g = background[1]
      let bl = background[2]
      let al = background[3]
      const onGlyph = Math.min(
        distanceToSegment(x + 0.5, y + 0.5, a, b),
        distanceToSegment(x + 0.5, y + 0.5, b, c),
        distanceToSegment(x + 0.5, y + 0.5, d, e)
      ) <= lineWidth / 2
      if (onGlyph) {
        r = glyph[0]
        g = glyph[1]
        bl = glyph[2]
        al = glyph[3]
      }
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = bl
      raw[offset + 3] = al
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function createIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16
  entries.forEach((entry, index) => {
    const size = entry.size
    const base = index * 16
    directory[base] = size >= 256 ? 0 : size
    directory[base + 1] = size >= 256 ? 0 : size
    directory[base + 2] = 0
    directory[base + 3] = 0
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, directory, ...entries.map(entry => entry.png)])
}

const resources = path.join(__dirname, '..', 'resources')
fs.mkdirSync(resources, { recursive: true })

const iconPng = createPng(256, { background: [15, 20, 28, 255], glyph: [127, 178, 255, 255], rounded: true })
fs.writeFileSync(path.join(resources, 'icon.png'), iconPng)

const trayPng = createPng(32, { background: [15, 20, 28, 255], glyph: [143, 211, 255, 255], rounded: true })
fs.writeFileSync(path.join(resources, 'tray.png'), trayPng)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoEntries = icoSizes.map(size => ({
  size,
  png: createPng(size, { background: [15, 20, 28, 255], glyph: [127, 178, 255, 255], rounded: true }),
}))
fs.writeFileSync(path.join(resources, 'icon.ico'), createIco(icoEntries))
console.log('icons written to', resources)
