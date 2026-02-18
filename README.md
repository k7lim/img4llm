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

# JSON output for scripting
img4llm optimize image.png --json
```

### CLI Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--max-dimension` | `-d` | 768 | Max width/height in pixels |
| `--quality` | `-q` | 85 | JPEG quality (1-100) |
| `--caption` | `-c` | false | Generate caption via Ollama |
| `--caption-model` | `-m` | qwen3-vl:4b | Ollama model for captions |
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
console.log(result.mimeType)    // 'image/jpeg'
console.log(result.strategy)    // ImageStrategy.RASTER_OPTIMIZE
console.log(result.metadata)    // { dimensions, format, filesize, ... }
console.log(result.caption)     // Generated caption (if requested)
```

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

**Returns:** `Promise<OptimizeResult>`
- `buffer` (Buffer) - Optimized image data
- `metadata` (ImageMetadata) - Original image metadata
- `strategy` (ImageStrategy) - Processing strategy used
- `mimeType` (string) - MIME type of output
- `caption` (string, optional) - Generated caption if requested

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
- `CONVERT_TO_SVG` - Convert to SVG (falls back to raster optimization)
- `KEEP_AS_IS` - Return unchanged (for SVGs)

## How It Works

1. **Analyze** - Extracts metadata (dimensions, format, color count, file size)
2. **Determine Strategy** - Chooses optimal processing based on image characteristics:
   - SVGs are kept as-is
   - Large files or many colors: raster optimization
   - Simple images with few colors: potential SVG conversion
3. **Process** - Applies the selected strategy (resize, compress)
4. **Caption** (optional) - Generates description via Ollama

## Requirements

- Node.js >= 18
- Ollama (optional, for caption generation)

## License

MIT
