declare module 'imagetracerjs' {
  interface ImageDataLike {
    width: number
    height: number
    data: Uint8ClampedArray
  }

  interface TracerOptions {
    /** Number of colors to use in the output (default: 16) */
    numberofcolors?: number
    /** Linear error threshold (default: 1) */
    ltres?: number
    /** Quadratic spline error threshold (default: 0.01) */
    qtres?: number
    /** Minimum path size to include (default: 8) - noise reduction */
    pathomit?: number
    /** Color quantization method: 1=pop, 2=median, 3=octree (default: 2) */
    colorsampling?: number
    /** Color quantization rounds (default: 3) */
    numberofiterations?: number
    /** Stroke width (default: 0) */
    strokewidth?: number
    /** Round coordinates to this precision (default: 1) */
    roundcoords?: number
    /** Use cubic bezier curves (default: false) */
    lcpr?: number
    /** Use quadratic bezier curves (default: false) */
    qcpr?: number
    /** Blend speckles into larger shapes (default: true) */
    blurradius?: number
    /** Blend delta (default: 0.5) */
    blurdelta?: number
  }

  interface ImageTracerStatic {
    /**
     * Convert ImageData to SVG string
     * @param imageData - Image data object with width, height, and RGBA data
     * @param options - Tracing options
     * @returns SVG string
     */
    imagedataToSVG(imageData: ImageDataLike, options?: TracerOptions): string

    /**
     * Convert ImageData to SVG path data array
     * @param imageData - Image data object with width, height, and RGBA data
     * @param options - Tracing options
     * @returns Array of SVG path data
     */
    imagedataToSVGpath(imageData: ImageDataLike, options?: TracerOptions): unknown[]

    /**
     * Convert an image URL to SVG string
     * @param url - Image URL
     * @param options - Tracing options
     * @param callback - Callback function
     */
    imageToSVG(url: string, options: TracerOptions, callback: (svg: string) => void): void
  }

  const ImageTracer: ImageTracerStatic
  export default ImageTracer
}
