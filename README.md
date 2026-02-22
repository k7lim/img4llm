# img4llm

Image optimization for LLM vision consumption. Reduces image file sizes while preserving visual quality for AI models.

## Installation

```bash
npm install img4llm
```

## CLI Usage

```bash
# Optimize single or multiple images
img4llm optimize image.png
img4llm optimize photo1.jpg photo2.png

# Analyze image without optimizing
img4llm analyze image.png

# With options
img4llm optimize image.png --max-dimension 512 --quality 80

# Generate caption via Ollama (requires Ollama running locally)
img4llm optimize image.png --caption --caption-model qwen3-vl:4b

# Generate semantic SVG for diagrams, icons, charts
img4llm optimize diagram.png --semantic-svg

# Combined: caption + semantic SVG in a single VLM call
img4llm optimize diagram.png --caption --semantic-svg

# JSON output for scripting
img4llm optimize image.png --json
```

### CLI Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--max-dimension` | `-d` | 768 | Max width/height in pixels |
| `--quality` | `-q` | 85 | JPEG quality (1-100) |
| `--caption` | `-c` | false | Generate caption via Ollama |
| `--semantic-svg` | | false | Generate semantic SVG via VLM |
| `--caption-model` | `-m` | qwen3-vl:4b | Ollama model for captions/SVG |
| `--output` | `-o` | - | Output path (single file only) |
| `--json` | | false | Machine-readable JSON output |
| `--help` | `-h` | | Show help |

## API Usage

```javascript
import { optimizeForLLM, analyzeImage, ImageStrategy } from 'img4llm'
import { readFile } from 'node:fs/promises'

// Optimize an image
const input = await readFile('image.png')
const result = await optimizeForLLM(input, {
  maxDimension: 768,
  quality: 85,
  generateCaption: true,
})

console.log(result.buffer)      // Optimized image Buffer
console.log(result.mimeType)    // 'image/jpeg' or 'image/svg+xml'
console.log(result.strategy)    // ImageStrategy.RASTER_OPTIMIZE or ImageStrategy.SEMANTIC_SVG
console.log(result.metadata)    // { dimensions, format, filesize, ... }
console.log(result.caption)     // Generated caption (if requested)
```

### Semantic SVG Generation

For diagrams, charts, icons, and simple illustrations, the VLM can generate clean
semantic SVG directly — far more token-efficient than bitmap tracing:

```javascript
const result = await optimizeForLLM(diagramBuffer, { semanticSvg: true })

if (result.strategy === 'SEMANTIC_SVG') {
  console.log(result.mimeType)  // 'image/svg+xml'
  // result.buffer contains clean semantic SVG (<5KB)
}

// Combine caption + SVG in a single VLM call (efficient)
const result = await optimizeForLLM(diagramBuffer, {
  generateCaption: true,
  semanticSvg: true,
})
```

SVG generation is handled by the VLM in a single API call. If the image isn't
suitable for SVG (photos, complex illustrations) or the generated SVG exceeds 5KB,
it falls back to optimized JPEG automatically.

### Analyzing Images

```javascript
import { analyzeImage } from 'img4llm'

const input = await readFile('image.png')
const analysis = await analyzeImage(input)

console.log(analysis.metadata)  // Image dimensions, format, colors, etc.
console.log(analysis.strategy)  // Recommended processing strategy
```

## API Reference

### `optimizeForLLM(input, options?)`

Main function to optimize an image for LLM consumption.

**Parameters:**
- `input` (Buffer) - The image buffer to optimize
- `options` (object, optional)
  - `maxDimension` (number) - Max width/height in pixels. Default: 768
  - `quality` (number) - JPEG quality 1-100. Default: 85
  - `generateCaption` (boolean) - Generate caption via Ollama. Default: false
  - `captionModel` (string) - Ollama model name. Default: 'qwen3-vl:4b'
  - `semanticSvg` (boolean) - Generate semantic SVG via VLM. Default: false

**Returns:** `Promise<OptimizeResult>`
- `buffer` (Buffer) - Optimized image data
- `metadata` (ImageMetadata) - Original image metadata
- `strategy` (ImageStrategy) - Processing strategy used
- `mimeType` (string) - MIME type of output
- `caption` (string, optional) - Generated caption if requested

### `analyzeWithVLM(input, options?)`

Unified VLM analysis — handles caption and/or SVG generation in a single Ollama call.

**Parameters:**
- `input` (Buffer) - The image buffer
- `options` (object, optional)
  - `caption` (boolean) - Include caption in analysis
  - `semanticSvg` (boolean) - Include SVG generation
  - `model` (string) - Ollama model name. Default: 'qwen3-vl:4b'

**Returns:** `Promise<VlmAnalysisResult>`
- `caption` (string) - Generated caption
- `svgCandidate` (boolean) - Whether image is suitable for SVG
- `svgReason` (string) - Reason for candidacy decision
- `svgCode` (string | null) - Generated SVG code, or null

**Throws:** Error if Ollama is unavailable

### `analyzeImage(input)`

Analyze an image and determine the optimal processing strategy.

**Parameters:**
- `input` (Buffer) - The image buffer to analyze

**Returns:** `Promise<ImageAnalysisResult>`
- `metadata` (ImageMetadata) - Image dimensions, format, colors, etc.
- `strategy` (ImageStrategy) - Recommended strategy
- `confidence` (number) - Confidence score (currently always 1)

### `extractMetadata(input)`

Extract metadata from an image buffer.

**Parameters:**
- `input` (Buffer) - The image buffer

**Returns:** `Promise<ImageMetadata>`
- `dimensions` ({ width, height }) - Image dimensions
- `format` (string) - Image format (jpeg, png, etc.)
- `filesize` (number) - File size in bytes
- `distinctColors` (number) - Approximate count of distinct colors
- `aspectRatio` (number) - Width divided by height

### `generateCaption(input, model?)`

Generate a caption for an image using Ollama.

**Parameters:**
- `input` (Buffer) - The image buffer
- `model` (string, optional) - Ollama model name. Default: 'qwen3-vl:4b'

**Returns:** `Promise<string>` - Generated caption

**Throws:** Error if Ollama is unavailable

### `ImageStrategy` (enum)

- `RASTER_OPTIMIZE` - Resize and compress as JPEG
- `SEMANTIC_SVG` - VLM-generated semantic SVG (diagrams, icons, charts)
- `KEEP_AS_IS` - Return unchanged (for existing SVGs)

## How It Works

1. **Analyze** - Extracts metadata (dimensions, format, color count, file size)
2. **Determine Strategy** - Chooses optimal processing:
   - SVGs are kept as-is
   - All raster images default to raster optimization
3. **VLM Analysis** (if `--caption` or `--semantic-svg`) - Single Ollama call handles:
   - Caption generation
   - SVG candidacy assessment (is this a diagram/icon/chart?)
   - Semantic SVG generation (if candidate, under 5KB)
4. **Process** - Applies the selected strategy:
   - Raster: resize and compress to JPEG
   - Semantic SVG: use VLM-generated SVG directly
   - Fallback: if VLM SVG is too large or image isn't suitable, use JPEG

### When Semantic SVG Works Best

- Diagrams and flowcharts
- Icons and logos
- Simple charts and graphs
- UI wireframes and mockups

The VLM generates clean semantic SVG using native SVG elements (`<line>`, `<rect>`,
`<circle>`, `<text>`, `<path>`). SVGs exceeding 5KB are discarded and the image
falls back to optimized JPEG.

## Requirements

- Node.js >= 18
- Ollama (optional, for caption and semantic SVG generation)

## License

MIT
