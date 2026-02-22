import sharp from 'sharp'
import {
  countDistinctColors,
  determineStrategy,
  optimizeRasterImage,
  generateCaption,
  getImageMimeType,
  optimizeForLLM,
  ImageStrategy,
  ImageMetadata,
} from '../src/index'

// --- Fixture helpers ---

async function makeSolidImage(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer()
}

async function makeStripedImage(width: number, height: number, colors: Array<{ r: number; g: number; b: number }>): Promise<Buffer> {
  const stripeHeight = Math.floor(height / colors.length)
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const colorIndex = Math.min(Math.floor(y / stripeHeight), colors.length - 1)
    const c = colors[colorIndex]
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      pixels[offset] = c.r
      pixels[offset + 1] = c.g
      pixels[offset + 2] = c.b
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

// Small 1x1 red PNG for testing
const TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64'
)

const OLLAMA_BASE = 'http://localhost:11434'

// --- countDistinctColors ---

describe('countDistinctColors', () => {
  it('returns 1 for a solid-color image', async () => {
    const img = await makeSolidImage(10, 10, { r: 255, g: 0, b: 0 })
    const count = await countDistinctColors(img)
    expect(count).toBe(1)
  })

  it('counts multiple distinct colors in a simple diagram', async () => {
    const colors = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]
    const img = await makeStripedImage(30, 30, colors)
    const count = await countDistinctColors(img)
    expect(count).toBe(3)
  })

  it('samples large images instead of reading every pixel', async () => {
    const img = await makeSolidImage(200, 200, { r: 128, g: 128, b: 128 })
    const count = await countDistinctColors(img, 100)
    expect(count).toBe(1)
  })

  it('respects sampleSize parameter', async () => {
    const colors = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
    ]
    const img = await makeStripedImage(100, 100, colors)
    const count = await countDistinctColors(img, 10)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(2)
  })
})

// --- determineStrategy ---

describe('determineStrategy', () => {
  it('returns KEEP_AS_IS for SVG format', () => {
    const metadata: ImageMetadata = {
      dimensions: { width: 100, height: 100 },
      format: 'svg',
      filesize: 5000,
      distinctColors: 10,
      aspectRatio: 1,
    }
    expect(determineStrategy(metadata)).toBe(ImageStrategy.KEEP_AS_IS)
  })

  it('returns RASTER_OPTIMIZE for high color count (>10,000)', () => {
    const metadata: ImageMetadata = {
      dimensions: { width: 800, height: 600 },
      format: 'png',
      filesize: 50_000,
      distinctColors: 15_000,
      aspectRatio: 800 / 600,
    }
    expect(determineStrategy(metadata)).toBe(ImageStrategy.RASTER_OPTIMIZE)
  })

  it('returns RASTER_OPTIMIZE for large file size (>1MB)', () => {
    const metadata: ImageMetadata = {
      dimensions: { width: 1920, height: 1080 },
      format: 'jpeg',
      filesize: 2_000_000,
      distinctColors: 100,
      aspectRatio: 1920 / 1080,
    }
    expect(determineStrategy(metadata)).toBe(ImageStrategy.RASTER_OPTIMIZE)
  })

  it('returns RASTER_OPTIMIZE for low color count and small file', () => {
    const metadata: ImageMetadata = {
      dimensions: { width: 200, height: 200 },
      format: 'png',
      filesize: 10_000,
      distinctColors: 16,
      aspectRatio: 1,
    }
    expect(determineStrategy(metadata)).toBe(ImageStrategy.RASTER_OPTIMIZE)
  })

  it('returns RASTER_OPTIMIZE when colors < 256 but file is large', () => {
    const metadata: ImageMetadata = {
      dimensions: { width: 500, height: 500 },
      format: 'png',
      filesize: 500_000,
      distinctColors: 100,
      aspectRatio: 1,
    }
    expect(determineStrategy(metadata)).toBe(ImageStrategy.RASTER_OPTIMIZE)
  })

  it('returns RASTER_OPTIMIZE as default for mid-range images', () => {
    const metadata: ImageMetadata = {
      dimensions: { width: 400, height: 300 },
      format: 'png',
      filesize: 150_000,
      distinctColors: 5_000,
      aspectRatio: 400 / 300,
    }
    expect(determineStrategy(metadata)).toBe(ImageStrategy.RASTER_OPTIMIZE)
  })
})

// --- optimizeRasterImage ---

describe('optimizeRasterImage', () => {
  it('resizes large images to fit within maxDimension', async () => {
    const img = await makeSolidImage(2000, 1500, { r: 100, g: 150, b: 200 })
    const result = await optimizeRasterImage(img, 768)
    const meta = await sharp(result).metadata()
    expect(meta.width).toBeLessThanOrEqual(768)
    expect(meta.height).toBeLessThanOrEqual(768)
  })

  it('preserves aspect ratio when resizing', async () => {
    const img = await makeSolidImage(2000, 1000, { r: 50, g: 50, b: 50 })
    const result = await optimizeRasterImage(img, 768)
    const meta = await sharp(result).metadata()
    expect(meta.width).toBe(768)
    expect(meta.height).toBe(384)
  })

  it('does not enlarge small images', async () => {
    const img = await makeSolidImage(100, 80, { r: 200, g: 100, b: 50 })
    const result = await optimizeRasterImage(img, 768)
    const meta = await sharp(result).metadata()
    expect(meta.width).toBe(100)
    expect(meta.height).toBe(80)
  })

  it('converts output to JPEG format', async () => {
    const img = await makeSolidImage(500, 500, { r: 0, g: 0, b: 255 })
    const result = await optimizeRasterImage(img)
    const meta = await sharp(result).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('uses custom maxDimension and quality', async () => {
    const img = await makeSolidImage(1000, 1000, { r: 128, g: 128, b: 128 })
    const result = await optimizeRasterImage(img, 500, 50)
    const meta = await sharp(result).metadata()
    expect(meta.width).toBeLessThanOrEqual(500)
    expect(meta.height).toBeLessThanOrEqual(500)
    expect(meta.format).toBe('jpeg')
  })
})

// --- generateCaption ---

describe('generateCaption', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('throws when ollama is unavailable', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(generateCaption(TEST_IMAGE)).rejects.toThrow('ollama is unavailable')
  })

  it('throws when health check returns non-ok', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(generateCaption(TEST_IMAGE)).rejects.toThrow('ollama is unavailable')
  })

  it('returns trimmed caption on success', async () => {
    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      if (url === `${OLLAMA_BASE}/api/tags`) {
        return Promise.resolve({ ok: true })
      }
      if (url === `${OLLAMA_BASE}/api/generate`) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ response: '  A red pixel image.  ' }),
        })
      }
      return Promise.reject(new Error('unexpected url'))
    })

    const result = await generateCaption(TEST_IMAGE)
    expect(result).toBe('A red pixel image.')
  })

  it('sends correct payload to ollama', async () => {
    const mockFetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === `${OLLAMA_BASE}/api/tags`) {
        return Promise.resolve({ ok: true })
      }
      if (url === `${OLLAMA_BASE}/api/generate`) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ response: 'caption' }),
        })
      }
      return Promise.reject(new Error('unexpected url'))
    })
    globalThis.fetch = mockFetch

    await generateCaption(TEST_IMAGE, 'custom-model')

    const generateCall = mockFetch.mock.calls.find(
      (c: [string, ...unknown[]]) => c[0] === `${OLLAMA_BASE}/api/generate`
    )
    expect(generateCall).toBeDefined()
    const body = JSON.parse(generateCall![1].body as string)
    expect(body.model).toBe('custom-model')
    expect(body.prompt).toContain('Under 100 words')
    expect(body.images).toHaveLength(1)
    expect(body.images[0]).toBe(TEST_IMAGE.toString('base64'))
    expect(body.stream).toBe(false)
  })

  it('returns empty string when generate endpoint fails', async () => {
    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      if (url === `${OLLAMA_BASE}/api/tags`) {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({ ok: false, status: 500 })
    })

    const result = await generateCaption(TEST_IMAGE)
    expect(result).toBe('')
  })

  it('returns empty string when response field is missing', async () => {
    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      if (url === `${OLLAMA_BASE}/api/tags`) {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    })

    const result = await generateCaption(TEST_IMAGE)
    expect(result).toBe('')
  })

  it('uses default model qwen3-vl:4b', async () => {
    const mockFetch = jest.fn().mockImplementation((url: string) => {
      if (url === `${OLLAMA_BASE}/api/tags`) {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: 'test' }),
      })
    })
    globalThis.fetch = mockFetch

    await generateCaption(TEST_IMAGE)

    const generateCall = mockFetch.mock.calls.find(
      (c: [string, ...unknown[]]) => c[0] === `${OLLAMA_BASE}/api/generate`
    )
    const body = JSON.parse(generateCall![1].body as string)
    expect(body.model).toBe('qwen3-vl:4b')
  })
})

// --- getImageMimeType ---

describe('getImageMimeType', () => {
  it('returns correct MIME types for all supported formats', () => {
    expect(getImageMimeType('photo.png')).toBe('image/png')
    expect(getImageMimeType('photo.jpg')).toBe('image/jpeg')
    expect(getImageMimeType('photo.jpeg')).toBe('image/jpeg')
    expect(getImageMimeType('photo.gif')).toBe('image/gif')
    expect(getImageMimeType('photo.webp')).toBe('image/webp')
    expect(getImageMimeType('photo.svg')).toBe('image/svg+xml')
  })

  it('handles uppercase extensions', () => {
    expect(getImageMimeType('photo.PNG')).toBe('image/png')
    expect(getImageMimeType('photo.JPG')).toBe('image/jpeg')
  })

  it('handles paths with directories', () => {
    expect(getImageMimeType('../images/photo.png')).toBe('image/png')
    expect(getImageMimeType('./assets/img.jpeg')).toBe('image/jpeg')
  })

  it('handles fragment identifiers', () => {
    expect(getImageMimeType('photo.png#anchor')).toBe('application/octet-stream')
    expect(getImageMimeType('image.jpg#section')).toBe('application/octet-stream')
  })

  it('returns fallback for unknown extensions', () => {
    expect(getImageMimeType('photo.unknown')).toBe('application/octet-stream')
    expect(getImageMimeType('photo')).toBe('application/octet-stream')
  })
})

// --- optimizeForLLM ---

describe('optimizeForLLM', () => {
  it('returns optimized JPEG with correct mimeType for a large image', async () => {
    // Create a large image with many unique colors using gradient pixels
    // Each pixel gets a pseudo-random color so sampling still sees >10k colors
    const width = 2000
    const height = 1500
    const pixels = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3
        pixels[offset] = x % 256
        pixels[offset + 1] = y % 256
        pixels[offset + 2] = (x + y) % 256
      }
    }
    const img = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()

    const result = await optimizeForLLM(img)

    expect(result.mimeType).toBe('image/jpeg')
    expect(result.strategy).toBe(ImageStrategy.RASTER_OPTIMIZE)
    expect(result.buffer).toBeInstanceOf(Buffer)

    const meta = await sharp(result.buffer).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBeLessThanOrEqual(768)
    expect(meta.height).toBeLessThanOrEqual(768)
  })

  it('returns caption:undefined gracefully when generateCaption:true with unavailable ollama', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    try {
      // Create an image with many colors to force RASTER_OPTIMIZE
      const width = 500
      const height = 500
      const pixels = Buffer.alloc(width * height * 3)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 3
          pixels[offset] = x % 256
          pixels[offset + 1] = y % 256
          pixels[offset + 2] = (x + y) % 256
        }
      }
      const img = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
      const result = await optimizeForLLM(img, { generateCaption: true })

      expect(result.caption).toBeUndefined()
      expect(result.buffer).toBeInstanceOf(Buffer)
      expect(result.mimeType).toBe('image/jpeg')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns RASTER_OPTIMIZE for simple images without VLM', async () => {
    // Without --semantic-svg, all raster images are optimized as JPEG
    const colors = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]
    const img = await makeStripedImage(30, 30, colors)

    const result = await optimizeForLLM(img)

    expect(result.strategy).toBe(ImageStrategy.RASTER_OPTIMIZE)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.buffer).toBeInstanceOf(Buffer)
  })

  it('uses SEMANTIC_SVG when VLM returns valid SVG', async () => {
    const originalFetch = globalThis.fetch
    const img = await makeSolidImage(30, 30, { r: 100, g: 200, b: 50 })
    const fakeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="green"/></svg>'

    globalThis.fetch = jest.fn().mockImplementation((url: string) => {
      if (url === `${OLLAMA_BASE}/api/tags`) {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          response: JSON.stringify({ caption: 'A green square', svgCandidate: true, svgReason: 'simple', svgCode: fakeSvg }),
        }),
      })
    })

    try {
      const result = await optimizeForLLM(img, { semanticSvg: true })
      expect(result.strategy).toBe(ImageStrategy.SEMANTIC_SVG)
      expect(result.mimeType).toBe('image/svg+xml')
      expect(result.buffer.toString('utf-8')).toContain('<svg')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
