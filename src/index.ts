import sharp from 'sharp'
import { extname } from 'node:path'

// --- Types ---

export interface ImageMetadata {
  dimensions: { width: number; height: number }
  format: string
  filesize: number
  distinctColors: number
  aspectRatio: number
}

export enum ImageStrategy {
  RASTER_OPTIMIZE = 'RASTER_OPTIMIZE',
  CONVERT_TO_SVG = 'CONVERT_TO_SVG',
  KEEP_AS_IS = 'KEEP_AS_IS',
}

export interface ImageAnalysisResult {
  metadata: ImageMetadata
  strategy: ImageStrategy
  confidence: number
}

export interface OptimizeOptions {
  maxDimension?: number
  quality?: number
  generateCaption?: boolean
  captionModel?: string
}

export interface OptimizeResult {
  buffer: Buffer
  metadata: ImageMetadata
  strategy: ImageStrategy
  mimeType: string
  caption?: string
}

// --- Image analysis ---

export async function extractMetadata(input: Buffer): Promise<ImageMetadata> {
  const meta = await sharp(input).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  const distinctColors = await countDistinctColors(input)
  return {
    dimensions: { width, height },
    format: meta.format ?? 'unknown',
    filesize: meta.size ?? input.length,
    distinctColors,
    aspectRatio: height > 0 ? width / height : 0,
  }
}

export async function countDistinctColors(input: Buffer, sampleSize = 1000): Promise<number> {
  const image = sharp(input).removeAlpha().raw()
  const { data, info } = await image.toBuffer({ resolveWithObject: true })
  if (!info.width || !info.height) {
    throw new Error('Unable to determine image dimensions')
  }
  const totalPixels = info.width * info.height
  const step = Math.max(1, Math.floor(totalPixels / sampleSize))
  const colors = new Set<number>()
  for (let i = 0; i < totalPixels; i += step) {
    const offset = i * 3
    const rgb = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
    colors.add(rgb)
  }
  return colors.size
}

export function determineStrategy(metadata: ImageMetadata): ImageStrategy {
  if (metadata.format === 'svg') return ImageStrategy.KEEP_AS_IS
  if (metadata.filesize > 1_000_000 || metadata.distinctColors > 10_000) return ImageStrategy.RASTER_OPTIMIZE
  if (metadata.distinctColors < 256 && metadata.filesize < 200_000) return ImageStrategy.CONVERT_TO_SVG
  return ImageStrategy.RASTER_OPTIMIZE
}

export async function optimizeRasterImage(input: Buffer, maxDimension = 768, quality = 85): Promise<Buffer> {
  return sharp(input)
    .resize(maxDimension, maxDimension, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer()
}

export async function analyzeImage(input: Buffer): Promise<ImageAnalysisResult> {
  const metadata = await extractMetadata(input)
  const strategy = determineStrategy(metadata)
  return { metadata, strategy, confidence: 1 }
}

// --- Caption generation ---

const OLLAMA_BASE_URL = 'http://localhost:11434'

export async function generateCaption(input: Buffer, model = 'qwen3-vl:4b'): Promise<string> {
  const healthRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`).catch(() => null)
  if (!healthRes || !healthRes.ok) {
    throw new Error('ollama is unavailable')
  }

  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: 'Describe this image concisely. Focus on main subject, text content, purpose. Under 100 words.',
      images: [input.toString('base64')],
      stream: false,
    }),
  })

  if (!res.ok) {
    return ''
  }

  const data = await res.json() as { response?: string }
  return (data.response ?? '').trim()
}

// --- MIME type helpers ---

export function getImageMimeType(filepath: string): string {
  const ext = extname(filepath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

export function getImageMimeTypeFromFormat(format: string): string {
  const normalized = format.toLowerCase()
  const mimeTypes: Record<string, string> = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  }
  return mimeTypes[normalized] || 'image/png'
}

// --- Strategy processing ---

export async function processImageByStrategy(
  buffer: Buffer,
  analysis: ImageAnalysisResult,
  maxDimension?: number,
  quality?: number,
): Promise<Buffer> {
  switch (analysis.strategy) {
    case ImageStrategy.RASTER_OPTIMIZE:
      return optimizeRasterImage(buffer, maxDimension, quality)
    case ImageStrategy.CONVERT_TO_SVG:
      // SVG conversion not yet implemented, falling back to raster optimization
      return optimizeRasterImage(buffer, maxDimension, quality)
    case ImageStrategy.KEEP_AS_IS:
      return buffer
  }
}

// --- Main API ---

export async function optimizeForLLM(input: Buffer, options?: OptimizeOptions): Promise<OptimizeResult> {
  const analysis = await analyzeImage(input)
  const processed = await processImageByStrategy(input, analysis, options?.maxDimension, options?.quality)
  const mimeType = analysis.strategy === ImageStrategy.KEEP_AS_IS
    ? getImageMimeTypeFromFormat(analysis.metadata.format)
    : 'image/jpeg'

  const result: OptimizeResult = {
    buffer: processed,
    metadata: analysis.metadata,
    strategy: analysis.strategy,
    mimeType,
  }

  if (options?.generateCaption) {
    try {
      result.caption = await generateCaption(input, options.captionModel)
    } catch {
      // Caption errors are non-fatal
    }
  }

  return result
}
