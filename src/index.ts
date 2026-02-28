import sharp from 'sharp'
import { extname } from 'node:path'

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
  /** VLM-generated semantic SVG */
  SEMANTIC_SVG = 'SEMANTIC_SVG',
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
  /** Ollama model to use for caption/SVG generation. Default: 'qwen3-vl:4b' */
  captionModel?: string
  /** Generate semantic SVG via VLM (for diagrams, charts, icons). Default: false */
  semanticSvg?: boolean
  /** Extract text for text-heavy images via VLM (OCR-style). Default: false */
  extractText?: boolean
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
  /** Extracted text content (only for text-only images) */
  extractedText?: string
}

/** Content type classification for images */
export type ContentType = 'diagram' | 'text' | 'photo' | 'complex'

/** Result of unified VLM analysis */
export interface VlmAnalysisResult {
  /** Generated caption */
  caption: string
  /** Classified content type of the image */
  contentType: ContentType
  /** Whether the image is a good SVG candidate */
  svgCandidate: boolean
  /** Reason for SVG candidacy decision */
  svgReason: string
  /** Generated SVG code, or null if not a candidate */
  svgCode: string | null
  /** Extracted text content, or null if not a text image */
  extractedText: string | null
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
 * - All raster images default to raster optimization
 * @param metadata - Image metadata to analyze
 * @returns Recommended processing strategy
 */
export function determineStrategy(metadata: ImageMetadata): ImageStrategy {
  if (metadata.format === 'svg') return ImageStrategy.KEEP_AS_IS
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

// --- VLM analysis ---

const OLLAMA_BASE_URL = 'http://localhost:11434'

const VLM_PROMPT_FULL = `Analyze this image and respond with JSON only, no markdown fences:
{
  "caption": "Brief description under 100 words",
  "contentType": "diagram" | "text" | "photo" | "complex",
  "svgCandidate": true or false (is this a simple diagram/chart/icon/logo?),
  "svgReason": "brief reason why or why not",
  "svgCode": "<svg>...</svg> if contentType is 'diagram', otherwise null",
  "extractedText": "All readable text if contentType is 'text', otherwise null"
}

Content type guidelines:
- "diagram": Charts, flowcharts, icons, simple illustrations
- "text": Documents, code screenshots, plain text images
- "photo": Photographs
- "complex": Detailed artwork with gradients/many colors

If diagram: generate minimal semantic SVG under 5KB
If text: extract all text, preserving structure and code indentation`

const VLM_PROMPT_CAPTION = `Describe this image concisely. Focus on main subject, text content, purpose. Under 100 words.
Respond with JSON only: {"caption": "your description"}`

/**
 * Analyze an image using a VLM (via Ollama) in a single call.
 * Handles caption generation and/or semantic SVG generation.
 * Requires Ollama to be running locally on port 11434.
 * @param input - The image buffer
 * @param options - Analysis options
 * @returns VLM analysis result with caption and optional SVG
 * @throws Error if Ollama is unavailable
 */
export async function analyzeWithVLM(
  input: Buffer,
  options: {
    caption?: boolean
    semanticSvg?: boolean
    extractText?: boolean
    mode?: 'caption' | 'full'
    model?: string
  } = {},
): Promise<VlmAnalysisResult> {
  const model = options.model ?? 'qwen3-vl:4b'

  const healthRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`).catch(() => null)
  if (!healthRes || !healthRes.ok) {
    throw new Error('ollama is unavailable')
  }

  const wantsFull =
    options.mode === 'full' ||
    options.semanticSvg === true ||
    options.extractText === true
  const prompt = wantsFull ? VLM_PROMPT_FULL : VLM_PROMPT_CAPTION

  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [input.toString('base64')],
      stream: false,
    }),
  })

  if (!res.ok) {
    return { caption: '', contentType: 'complex', svgCandidate: false, svgReason: '', svgCode: null, extractedText: null }
  }

  const data = await res.json() as { response?: string }
  const raw = (data.response ?? '').trim()

  // Extract JSON from response (VLMs may include extra text)
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { caption: raw, contentType: 'complex', svgCandidate: false, svgReason: '', svgCode: null, extractedText: null }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<VlmAnalysisResult> & { contentType?: string }
    const validContentTypes = ['diagram', 'text', 'photo', 'complex'] as const
    const contentType = validContentTypes.includes(parsed.contentType as typeof validContentTypes[number])
      ? parsed.contentType as ContentType
      : 'complex'
    return {
      caption: typeof parsed.caption === 'string' ? parsed.caption.trim() : '',
      contentType,
      svgCandidate: parsed.svgCandidate === true,
      svgReason: typeof parsed.svgReason === 'string' ? parsed.svgReason : '',
      svgCode: typeof parsed.svgCode === 'string' ? parsed.svgCode : null,
      extractedText: typeof parsed.extractedText === 'string' ? parsed.extractedText : null,
    }
  } catch {
    return { caption: raw, contentType: 'complex', svgCandidate: false, svgReason: '', svgCode: null, extractedText: null }
  }
}

function isLikelySemanticSvg(svgCode: string, maxBytes: number): boolean {
  const svg = svgCode.trim()
  if (!svg.startsWith('<svg')) return false
  if (Buffer.byteLength(svg, 'utf8') > maxBytes) return false
  if (/<image\b/i.test(svg)) return false
  if (/href\s*=\s*["']data:image\//i.test(svg)) return false

  const pathCount = (svg.match(/<path\b/gi) || []).length
  if (pathCount > 10) return false

  const hasTextOrShapes = /<(text|rect|circle|line|polyline|polygon)\b/i.test(svg)
  if (!hasTextOrShapes) return false

  return true
}

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
  const result = await analyzeWithVLM(input, { caption: true, model })
  return result.caption
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
): Promise<Buffer> {
  switch (analysis.strategy) {
    case ImageStrategy.RASTER_OPTIMIZE:
      return optimizeRasterImage(buffer, maxDimension, quality)
    case ImageStrategy.SEMANTIC_SVG:
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
 * generates a caption and/or semantic SVG using a single Ollama VLM call.
 *
 * @param input - The image buffer to optimize
 * @param options - Optimization options
 * @param options.maxDimension - Maximum width/height in pixels. Default: 768
 * @param options.quality - JPEG quality (1-100). Default: 85
 * @param options.generateCaption - Generate caption via Ollama. Default: false
 * @param options.captionModel - Ollama model for captions/SVG. Default: 'qwen3-vl:4b'
 * @param options.semanticSvg - Generate semantic SVG via VLM. Default: false
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

  // If VLM requested (caption and/or semanticSvg), do a single unified call
  if (options?.generateCaption || options?.semanticSvg || options?.extractText) {
    let vlmResult: VlmAnalysisResult | null = null
    try {
      vlmResult = await analyzeWithVLM(input, {
        caption: options.generateCaption,
        semanticSvg: options.semanticSvg,
        extractText: options.extractText,
        mode: (options.semanticSvg || options.extractText) ? 'full' : 'caption',
        model: options.captionModel,
      })
    } catch {
      // VLM errors are non-fatal; fall through to raster optimization
    }

    // Use VLM-generated SVG if it's a candidate and within size limit
    if (options.semanticSvg && vlmResult?.svgCandidate && vlmResult.svgCode) {
      if (isLikelySemanticSvg(vlmResult.svgCode, 5120)) {
        const svgBuffer = Buffer.from(vlmResult.svgCode, 'utf-8')
        return {
          buffer: svgBuffer,
          metadata: analysis.metadata,
          strategy: ImageStrategy.SEMANTIC_SVG,
          mimeType: 'image/svg+xml',
          ...(options.generateCaption && vlmResult.caption ? { caption: vlmResult.caption } : {}),
        }
      }
    }

    // Handle text-only images: return minimal JPEG + extracted text
    if ((options.extractText || options.generateCaption) && vlmResult?.contentType === 'text' && vlmResult.extractedText) {
      const processed = await processImageByStrategy(input, analysis, options?.maxDimension, options?.quality)
      return {
        buffer: processed,
        metadata: analysis.metadata,
        strategy: ImageStrategy.RASTER_OPTIMIZE,
        mimeType: 'image/jpeg',
        ...(options.generateCaption && vlmResult.caption ? { caption: vlmResult.caption } : {}),
        extractedText: vlmResult.extractedText,
      }
    }

    // Fall back to metadata-determined strategy
    const processed = await processImageByStrategy(input, analysis, options?.maxDimension, options?.quality)
    const mimeType = analysis.strategy === ImageStrategy.KEEP_AS_IS
      ? getImageMimeTypeFromFormat(analysis.metadata.format)
      : 'image/jpeg'
    return {
      buffer: processed,
      metadata: analysis.metadata,
      strategy: analysis.strategy,
      mimeType,
      ...(options?.generateCaption && vlmResult?.caption ? { caption: vlmResult.caption } : {}),
    }
  }

  // No VLM requested — just optimize
  const processed = await processImageByStrategy(input, analysis, options?.maxDimension, options?.quality)
  const mimeType = analysis.strategy === ImageStrategy.KEEP_AS_IS
    ? getImageMimeTypeFromFormat(analysis.metadata.format)
    : 'image/jpeg'
  return {
    buffer: processed,
    metadata: analysis.metadata,
    strategy: analysis.strategy,
    mimeType,
  }
}
