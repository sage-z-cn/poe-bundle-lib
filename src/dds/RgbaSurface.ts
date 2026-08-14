import { createCanvas, ImageData } from '@napi-rs/canvas';

/**
 * RgbaSurface - represents a decoded RGBA8888 pixel surface (row-major).
 */
export class RgbaSurface {
  readonly width: number;
  readonly height: number;
  /**
   * RGBA8888 pixel data, row-major, 4 bytes per pixel.
   */
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, pixels?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.pixels = pixels ?? new Uint8Array(width * height * 4);
  }

  /**
   * Read the RGBA value of a pixel as a packed 0xRRGGBBAA number.
   * @param x - Zero-based column index
   * @param y - Zero-based row index
   */
  pixel(x: number, y: number): number {
    const i = (y * this.width + x) * 4;
    return (this.pixels[i] << 24) | (this.pixels[i + 1] << 16) | (this.pixels[i + 2] << 8) | this.pixels[i + 3];
  }

  /**
   * Encode the surface as a PNG image.
   */
  toPng(): Buffer {
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(this.pixels.buffer, this.pixels.byteOffset, this.pixels.length), this.width, this.height),
      0,
      0,
    );
    return canvas.encodeSync('png');
  }
}

/**
 * Downsample a surface by a factor of two using a 2x2 box filter.
 * Odd source dimensions are clamped at the edges (srcX = min(col*2+dx, width-1)).
 * A 1x1 surface maps to another 1x1 surface.
 */
export function downsample2x2(surface: RgbaSurface): RgbaSurface {
  const w = Math.max(1, surface.width >> 1);
  const h = Math.max(1, surface.height >> 1);
  const src = surface.pixels;
  const dst = new Uint8Array(w * h * 4);
  const srcW = surface.width;
  const srcH = surface.height;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Clamp source coordinates for odd dimensions
      const x0 = Math.min(x * 2, srcW - 1);
      const x1 = Math.min(x * 2 + 1, srcW - 1);
      const y0 = Math.min(y * 2, srcH - 1);
      const y1 = Math.min(y * 2 + 1, srcH - 1);
      const p00 = (y0 * srcW + x0) * 4;
      const p01 = (y0 * srcW + x1) * 4;
      const p10 = (y1 * srcW + x0) * 4;
      const p11 = (y1 * srcW + x1) * 4;
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        dst[d + c] = (src[p00 + c] + src[p01 + c] + src[p10 + c] + src[p11 + c] + 2) >> 2;
      }
    }
  }
  return new RgbaSurface(w, h, dst);
}
