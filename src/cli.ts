#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, basename, extname } from 'node:path'
import { optimizeForLLM, analyzeImage, ImageStrategy } from './index'
import type { OptimizeOptions } from './index'

// --- Help ---

const HELP = `Usage: img4llm [command] <file...>

Commands:
  optimize <file...>   Optimize image(s) for LLM vision (default)
  analyze  <file>      Analyze image and print metadata + strategy

Options:
  -d, --max-dimension <px>   Max width/height (default: 768)
  -q, --quality <1-100>      JPEG quality (default: 85)
  -c, --caption              Generate caption via Ollama
      --semantic-svg         Generate semantic SVG via VLM (diagrams, icons)
      --extract-text         Extract text for text-heavy images via VLM
  -m, --caption-model <name> Ollama model (default: qwen3-vl:4b)
  -o, --output <path>        Output path (single file only)
      --json                 Machine-readable JSON output
  -h, --help                 Show this help`

// --- Arg parsing ---

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'max-dimension': { type: 'string', short: 'd' },
    quality:         { type: 'string', short: 'q' },
    caption:         { type: 'boolean', short: 'c' },
    'semantic-svg':  { type: 'boolean' },
    'extract-text':  { type: 'boolean' },
    'caption-model': { type: 'string', short: 'm' },
    output:          { type: 'string', short: 'o' },
    json:            { type: 'boolean' },
    help:            { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
})

// --- Validation ---

if (values['max-dimension'] !== undefined && (Number.isNaN(Number(values['max-dimension'])) || Number(values['max-dimension']) <= 0)) {
  process.stderr.write(`Error: --max-dimension must be a positive number, got "${values['max-dimension']}"\n`)
  process.exit(1)
}

if (values.quality !== undefined) {
  const q = Number(values.quality)
  if (Number.isNaN(q) || q < 1 || q > 100) {
    process.stderr.write(`Error: --quality must be 1-100, got "${values.quality}"\n`)
    process.exit(1)
  }
}

// --- Help / no args ---

if (values.help || positionals.length === 0) {
  console.log(HELP)
  process.exit(0)
}

// --- Command dispatch ---

const COMMANDS = ['optimize', 'analyze'] as const
type Command = typeof COMMANDS[number]

let command: Command = 'optimize'
let files: string[]

if (COMMANDS.includes(positionals[0] as Command)) {
  command = positionals[0] as Command
  files = positionals.slice(1)
} else {
  files = [...positionals]
}

if (files.length === 0) {
  console.log(HELP)
  process.exit(1)
}

// --- Glob expansion ---

async function expandGlobs(patterns: string[]): Promise<string[]> {
  const expanded: string[] = []
  for (const pattern of patterns) {
    if (/[*?\[]/.test(pattern)) {
      try {
        const fs = await import('node:fs') as Record<string, unknown>
        const glob = fs.glob as ((pattern: string, cb: (err: Error | null, matches: string[]) => void) => void) | undefined
        if (typeof glob === 'function') {
          const matches = await new Promise<string[]>((res, rej) => {
            glob(pattern, (err: Error | null, m: string[]) => {
              if (err) { rej(err); return }
              res(m)
            })
          })
          if (matches.length === 0) {
            process.stderr.write(`Warning: no matches for pattern "${pattern}"\n`)
          } else {
            expanded.push(...matches)
          }
        } else {
          // glob not available as callback form, treat as literal
          expanded.push(pattern)
        }
      } catch {
        // node:fs glob unavailable (Node <22), treat as literal path
        // Shell expands unquoted globs anyway, so this is fine
        expanded.push(pattern)
      }
    } else {
      expanded.push(pattern)
    }
  }
  return expanded
}

// --- Size formatting ---

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)}KB`
  return `${bytes}B`
}

// --- Output extension ---

function getOutputPath(inputPath: string, strategy: ImageStrategy): string {
  const ext = extname(inputPath)
  const base = basename(inputPath, ext)
  const dir = resolve(inputPath, '..')
  if (strategy === ImageStrategy.KEEP_AS_IS) {
    return resolve(dir, `${base}.optimized${ext}`)
  }
  if (strategy === ImageStrategy.SEMANTIC_SVG) {
    return resolve(dir, `${base}.optimized.svg`)
  }
  return resolve(dir, `${base}.optimized.jpg`)
}

// --- Optimize command ---

interface OptimizeJsonEntry {
  input: string
  output: string
  strategy: string
  inputSize: number
  outputSize: number
  dimensions: { width: number; height: number }
  caption?: string
  extractedText?: string
}

async function runOptimize(filePaths: string[]): Promise<void> {
  const opts: OptimizeOptions = {
    maxDimension: values['max-dimension'] ? Number(values['max-dimension']) : undefined,
    quality: values.quality ? Number(values.quality) : undefined,
    generateCaption: values.caption,
    captionModel: values['caption-model'],
    semanticSvg: values['semantic-svg'],
    extractText: values['extract-text'],
  }

  if (values.output && filePaths.length > 1) {
    process.stderr.write('Error: --output can only be used with a single file\n')
    process.exit(1)
  }

  const jsonEntries: OptimizeJsonEntry[] = []
  let failures = 0

  const results = await Promise.allSettled(filePaths.map(async (filePath) => {
    const inputBuffer = await readFile(resolve(filePath))
    const result = await optimizeForLLM(inputBuffer, opts)
    const outputPath = values.output ? resolve(values.output) : getOutputPath(filePath, result.strategy)
    await writeFile(outputPath, result.buffer)
    return { filePath, result, outputPath, inputSize: inputBuffer.length }
  }))

  for (const settled of results) {
    if (settled.status === 'rejected') {
      const err = settled.reason as Error
      process.stderr.write(`✗ ${err.message}\n`)
      failures++
      continue
    }

    const { filePath, result, outputPath, inputSize } = settled.value

    if (values.json) {
      jsonEntries.push({
        input: basename(filePath),
        output: basename(outputPath),
        strategy: result.strategy,
        inputSize,
        outputSize: result.buffer.length,
        dimensions: result.metadata.dimensions,
        ...(result.caption ? { caption: result.caption } : {}),
        ...(result.extractedText ? { extractedText: result.extractedText } : {}),
      })
    } else {
      const inputName = basename(filePath)
      const outputName = basename(outputPath)
      console.log(`✓ ${inputName} → ${outputName} (${result.strategy}, ${formatSize(inputSize)} → ${formatSize(result.buffer.length)})`)
      if (result.caption) {
        console.log(`  caption: "${result.caption}"`)
      }
      if (result.extractedText) {
        const preview = result.extractedText.length > 100
          ? result.extractedText.slice(0, 100) + '...'
          : result.extractedText
        console.log(`  extractedText: "${preview.replace(/\n/g, '\\n')}"`)
      }
    }
  }

  if (values.json) {
    console.log(JSON.stringify(jsonEntries, null, 2))
  }

  if (failures === filePaths.length) process.exit(1)
}

// --- Analyze command ---

async function runAnalyze(filePaths: string[]): Promise<void> {
  let failures = 0

  for (const filePath of filePaths) {
    try {
      const inputBuffer = await readFile(resolve(filePath))
      const analysis = await analyzeImage(inputBuffer)
      const output = {
        file: basename(filePath),
        metadata: analysis.metadata,
        strategy: analysis.strategy,
        confidence: analysis.confidence,
      }
      console.log(JSON.stringify(output))
    } catch (err) {
      process.stderr.write(`✗ ${basename(filePath)}: ${(err as Error).message}\n`)
      failures++
    }
  }

  if (failures === filePaths.length) process.exit(1)
}

// --- Main ---

async function main(): Promise<void> {
  const expandedFiles = await expandGlobs(files)

  if (expandedFiles.length === 0) {
    console.log(HELP)
    process.exit(1)
  }

  if (command === 'optimize') {
    await runOptimize(expandedFiles)
  } else {
    await runAnalyze(expandedFiles)
  }
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
