import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const execFile = promisify(execFileCb)
const CLI = join(__dirname, '..', 'src', 'cli.ts')
const run = (args: string[]) =>
  execFile('npx', ['tsx', CLI, ...args], { timeout: 30_000 })

jest.setTimeout(30_000)

let tmpDir: string
let testPng: string
let largePng: string
let tinyPng: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'img4llm-cli-'))

  // 200x200 solid red PNG
  const redBuf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer()
  testPng = join(tmpDir, 'test.png')
  await writeFile(testPng, redBuf)

  // 2000x1500 gradient PNG (many colors → RASTER_OPTIMIZE)
  const w = 2000, h = 1500
  const pixels = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 3
      pixels[off] = x % 256
      pixels[off + 1] = y % 256
      pixels[off + 2] = (x + y) % 256
    }
  }
  const largeBuf = await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
  largePng = join(tmpDir, 'large.png')
  await writeFile(largePng, largeBuf)

  // 10x10 solid blue PNG (few colors, small → CONVERT_TO_SVG)
  const blueBuf = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } },
  }).png().toBuffer()
  tinyPng = join(tmpDir, 'tiny.png')
  await writeFile(tinyPng, blueBuf)
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// --- Tests ---

describe('CLI integration', () => {
  it('--help prints usage and exits 0', async () => {
    const { stdout } = await run(['--help'])
    expect(stdout).toContain('Usage: img4llm')
  })

  it('no args prints help and exits 0', async () => {
    const { stdout } = await run([])
    expect(stdout).toContain('Usage: img4llm')
  })

  it('optimize subcommand with no files prints help and exits 1', async () => {
    await expect(run(['optimize'])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('Usage: img4llm'),
    })
  })

  it('optimize single file (default command)', async () => {
    const { stdout } = await run([largePng])
    expect(stdout).toContain('→')
    const outputPath = join(tmpDir, 'large.optimized.jpg')
    expect(existsSync(outputPath)).toBe(true)
    const meta = await sharp(outputPath).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('optimize with explicit subcommand', async () => {
    // Clean up from previous test
    const outputPath = join(tmpDir, 'large.optimized.jpg')
    if (existsSync(outputPath)) await rm(outputPath)

    const { stdout } = await run(['optimize', largePng])
    expect(stdout).toContain('→')
    expect(existsSync(outputPath)).toBe(true)
  })

  it('optimize with --output flag', async () => {
    const customOut = join(tmpDir, 'custom.jpg')
    await run([largePng, '--output', customOut])
    expect(existsSync(customOut)).toBe(true)
    const meta = await sharp(customOut).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('optimize with --max-dimension and --quality', async () => {
    const outPath = join(tmpDir, 'large.optimized.jpg')
    if (existsSync(outPath)) await rm(outPath)

    await run([largePng, '-d', '256', '-q', '50'])
    expect(existsSync(outPath)).toBe(true)
    const meta = await sharp(outPath).metadata()
    expect(meta.width).toBeLessThanOrEqual(256)
    expect(meta.height).toBeLessThanOrEqual(256)
  })

  it('optimize with --json flag', async () => {
    const { stdout } = await run([largePng, '--json'])
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(1)
    const entry = parsed[0]
    expect(entry).toHaveProperty('input')
    expect(entry).toHaveProperty('output')
    expect(entry).toHaveProperty('strategy')
    expect(entry).toHaveProperty('inputSize')
    expect(entry).toHaveProperty('outputSize')
    expect(entry).toHaveProperty('dimensions')
  })

  it('optimize multiple files', async () => {
    // Clean up
    for (const f of ['test.optimized.jpg', 'test.optimized.svg', 'large.optimized.jpg']) {
      const p = join(tmpDir, f)
      if (existsSync(p)) await rm(p)
    }

    await run([testPng, largePng])
    // testPng (solid red) will be converted to SVG
    expect(existsSync(join(tmpDir, 'test.optimized.svg'))).toBe(true)
    // largePng (gradient) will be raster optimized
    expect(existsSync(join(tmpDir, 'large.optimized.jpg'))).toBe(true)
  })

  it('analyze subcommand', async () => {
    const { stdout } = await run(['analyze', testPng])
    const parsed = JSON.parse(stdout.trim())
    expect(parsed).toHaveProperty('metadata')
    expect(parsed.metadata).toHaveProperty('dimensions')
    expect(parsed).toHaveProperty('strategy')
    expect(parsed).toHaveProperty('confidence')
  })

  it('analyze multiple files outputs JSONL', async () => {
    const { stdout } = await run(['analyze', testPng, largePng])
    const lines = stdout.trim().split('\n')
    expect(lines.length).toBe(2)
    for (const line of lines) {
      const parsed = JSON.parse(line)
      expect(parsed).toHaveProperty('metadata')
      expect(parsed).toHaveProperty('strategy')
    }
  })

  it('missing file prints error to stderr', async () => {
    const fakePath = join(tmpDir, 'nonexistent.png')
    await expect(run([fakePath])).rejects.toMatchObject({
      stderr: expect.stringContaining('nonexistent.png'),
    })
  })

  it('handles CONVERT_TO_SVG strategy output extension', async () => {
    const { stdout } = await run([tinyPng, '--json'])
    const parsed = JSON.parse(stdout)
    expect(parsed[0].strategy).toBe('CONVERT_TO_SVG')
    // CONVERT_TO_SVG should output .svg extension
    const svgPath = join(tmpDir, 'tiny.optimized.svg')
    expect(existsSync(svgPath)).toBe(true)
  })
})
