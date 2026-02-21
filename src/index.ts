import sharp from 'sharp'
import { extname } from 'node:path'
import ImageTracer from 'imagetracerjs'

// --- Types ---

/** Image metadata extracted from the input buffer */
export interface ImageMetadata {
  /** Image dimensions in pixels */
  dimensions: { width: number; height: number }
  /** Image format (jpeg, png, webp, gif, svg, etc.) */
  format: string
  /** File size in bytes */
  filesize: number
  /** Approximate count of distinct colors (sampled) */
  distinctColors: number
  /** Aspect ratio (width / height) */
  aspectRatio: number
}

/** Processing strategy determined by image analysis */
export enum ImageStrategy {
  /** Resize and compress as JPEG */
  RASTER_OPTIMIZE = 'RASTER_OPTIMIZE',
  /** Convert to SVG (currently falls back to RASTER_OPTIMIZE) */
  CONVERT_TO_SVG = 'CONVERT_TO_SVG',
  /** Return unchanged (used for SVGs) */
  KEEP_AS_IS = 'KEEP_AS_IS',
}

/** Result of analyzing an image */
export interface ImageAnalysisResult {
  /** Extracted image metadata */
  metadata: ImageMetadata
  /** Recommended processing strategy */
  strategy: ImageStrategy
  /** Confidence score (currently always 1) */
  confidence: number
}

/** Options for image optimization */
export interface OptimizeOptions {
  /** Maximum width/height in pixels. Default: 768 */
  maxDimension?: number
  /** JPEG quality (1-100). Default: 85 */
  quality?: number
  /** Generate a caption using Ollama. Default: false */
  generateCaption?: boolean
  /** Ollama model to use for caption generation. Default: 'qwen3-vl:4b' */
  captionModel?: string
  /** Maximum colors for SVG conversion. Default: 16 */
  maxSvgColors?: number
}

/** Result of image optimization */
export interface OptimizeResult {
  /** Optimized image buffer */
  buffer: Buffer
  /** Metadata from the original image */
  metadata: ImageMetadata
  /** Processing strategy that was applied */
  strategy: ImageStrategy
  /** MIME type of the output image */
  mimeType: string
  /** Generated caption (only if generateCaption was true) */
  caption?: string
}

// --- Image analysis ---

/**
 * Extract metadata from an image buffer.
 * @param input - The image buffer to analyze
 * @returns Image metadata including dimensions, format, file size, and color information
 * @example
 * const buffer = await readFile('image.png')
 * const metadata = await extractMetadata(buffer)
 * console.log(metadata.dimensions) // { width: 1920, height: 1080 }
 */
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

/**
 * Count approximate number of distinct colors in an image.
 * Uses sampling for performance on large images.
 * @param input - The image buffer
 * @param sampleSize - Number of pixels to sample. Default: 1000
 * @returns Approximate count of distinct colors
 */
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

/**
 * Determine the optimal processing strategy based on image metadata.
 * - SVGs are kept as-is
 * - Large files (>1MB) or many colors (>10k): raster optimization
 * - Simple images (<256 colors, <200KB): potential SVG conversion
 * @param metadata - Image metadata to analyze
 * @returns Recommended processing strategy
 */
export function determineStrategy(metadata: ImageMetadata): ImageStrategy {
  if (metadata.format === 'svg') return ImageStrategy.KEEP_AS_IS
  if (metadata.filesize > 1_000_000 || metadata.distinctColors > 10_000) return ImageStrategy.RASTER_OPTIMIZE
  if (metadata.distinctColors < 256 && metadata.filesize < 200_000) return ImageStrategy.CONVERT_TO_SVG
  return ImageStrategy.RASTER_OPTIMIZE
}

/**
 * Optimize a raster image by resizing and compressing to JPEG.
 * @param input - The image buffer to optimize
 * @param maxDimension - Maximum width/height in pixels. Default: 768
 * @param quality - JPEG quality (1-100). Default: 85
 * @returns Optimized image buffer as JPEG
 */
export async function optimizeRasterImage(input: Buffer, maxDimension = 768, quality = 85): Promise<Buffer> {
  return sharp(input)
    .resize(maxDimension, maxDimension, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer()
}

/**
 * Convert a raster image to SVG using imagetracerjs.
 * @param input - The image buffer to convert
 * @param maxColors - Maximum number of colors in the output SVG. Default: 16
 * @returns SVG buffer
 */
export async function convertToSvg(input: Buffer, maxColors = 16): Promise<Buffer> {
  // Get RGBA pixel data via sharp
  const image = sharp(input).ensureAlpha()
  const { data, info } = await image
    .clone()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Create ImageData object for imagetracerjs
  // Note: imagetracerjs expects { width, height, data } where data is RGBA bytes
  const imageData = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  }

  // Trace to SVG string
  const svgString = ImageTracer.imagedataToSVG(imageData, {
    numberofcolors: maxColors,
    ltres: 1, // linear tolerance
    qtres: 0.01, // quadratic spline tolerance
    pathomit: 8, // omit small paths (noise reduction)
  })

  return Buffer.from(svgString, 'utf-8')
}

/**
 * Analyze an image and determine the optimal processing strategy.
 * @param input - The image buffer to analyze
 * @returns Analysis result with metadata and recommended strategy
 * @example
 * const buffer = await readFile('image.png')
 * const analysis = await analyzeImage(buffer)
 * console.log(analysis.strategy) // ImageStrategy.RASTER_OPTIMIZE
 */
export async function analyzeImage(input: Buffer): Promise<ImageAnalysisResult> {
  const metadata = await extractMetadata(input)
  const strategy = determineStrategy(metadata)
  return { metadata, strategy, confidence: 1 }
}

// --- Caption generation ---

const OLLAMA_BASE_URL = 'http://localhost:11434'

/**
 * Generate a caption for an image using Ollama vision models.
 * Requires Ollama to be running locally on port 11434.
 * @param input - The image buffer
 * @param model - Ollama model name. Default: 'qwen3-vl:4b'
 * @returns Generated caption string
 * @throws Error if Ollama is unavailable
 * @example
 * const buffer = await readFile('photo.jpg')
 * const caption = await generateCaption(buffer)
 * console.log(caption) // "A cat sitting on a windowsill"
 */
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

/**
 * Get MIME type from a file path extension.
 * @param filepath - File path with extension
 * @returns MIME type string (e.g., 'image/jpeg')
 */
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

/**
 * Get MIME type from an image format string.
 * @param format - Image format (jpeg, png, webp, gif, svg)
 * @returns MIME type string
 */
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

/**
 * Process an image according to the determined strategy.
 * @param buffer - The image buffer to process
 * @param analysis - Analysis result containing the strategy to apply
 * @param maxDimension - Maximum width/height for raster optimization
 * @param quality - JPEG quality for raster optimization
 * @returns Processed image buffer
 */
export async function processImageByStrategy(
  buffer: Buffer,
  analysis: ImageAnalysisResult,
  maxDimension?: number,
  quality?: number,
  maxSvgColors?: number,
): Promise<Buffer> {
  switch (analysis.strategy) {
    case ImageStrategy.RASTER_OPTIMIZE:
      return optimizeRasterImage(buffer, maxDimension, quality)
    case ImageStrategy.CONVERT_TO_SVG:
      try {
        return await convertToSvg(buffer, maxSvgColors)
      } catch {
        // Fall back to raster if SVG conversion fails
        return optimizeRasterImage(buffer, maxDimension, quality)
      }
    case ImageStrategy.KEEP_AS_IS:
      return buffer
  }
}

// --- Main API ---

/**
 * Optimize an image for LLM vision consumption.
 *
 * This is the main entry point for image optimization. It analyzes the image,
 * determines the best strategy, processes it accordingly, and optionally
 * generates a caption using Ollama.
 *
 * @param input - The image buffer to optimize
 * @param options - Optimization options
 * @param options.maxDimension - Maximum width/height in pixels. Default: 768
 * @param options.quality - JPEG quality (1-100). Default: 85
 * @param options.generateCaption - Generate caption via Ollama. Default: false
 * @param options.captionModel - Ollama model for captions. Default: 'qwen3-vl:4b'
 * @returns Optimization result with processed buffer, metadata, and optional caption
 * @example
 * import { optimizeForLLM } from 'img4llm'
 * import { readFile, writeFile } from 'node:fs/promises'
 *
 * const input = await readFile('large-photo.png')
 * const result = await optimizeForLLM(input, {
 *   maxDimension: 512,
 *   quality: 80,
 *   generateCaption: true,
 * })
 *
 * await writeFile('optimized.jpg', result.buffer)
 * console.log(`Strategy: ${result.strategy}`)
 * console.log(`Caption: ${result.caption}`)
 */
export async function optimizeForLLM(input: Buffer, options?: OptimizeOptions): Promise<OptimizeResult> {
  const analysis = await analyzeImage(input)
  const processed = await processImageByStrategy(
    input,
    analysis,
    options?.maxDimension,
    options?.quality,
    options?.maxSvgColors,
  )
  const mimeType = analysis.strategy === ImageStrategy.KEEP_AS_IS
    ? getImageMimeTypeFromFormat(analysis.metadata.format)
    : analysis.strategy === ImageStrategy.CONVERT_TO_SVG
      ? 'image/svg+xml'
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
