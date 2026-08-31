import { createRequire } from 'node:module';
import type { SKRSContext2D } from '@napi-rs/canvas';

// @napi-rs/canvas is an optional peer of this library (only needed by dds
// features). It is loaded lazily so consumers that don't use dds don't pay
// for the large multi-platform binary package.
const require = createRequire(import.meta.url);
let canvasModule: typeof import('@napi-rs/canvas') | null = null;

function loadCanvas(): typeof import('@napi-rs/canvas') {
  if (canvasModule === null) {
    try {
      canvasModule = require('@napi-rs/canvas');
    } catch {
      throw new Error(
        "dds features require the optional dependency '@napi-rs/canvas'. Install it in your project: npm i @napi-rs/canvas",
      );
    }
  }
  return canvasModule!;
}
import { RgbaSurface } from './RgbaSurface.js';

/**
 * Length value: pixels as number, or a percentage string like '5%' / '12.5%'.
 * Percentages of x/left/right resolve against the surface width, of y/top/bottom
 * and fontSize against the surface height.
 */
export type TextLength = number | string;

/**
 * Centering mode: center the text block on the given axes, overriding the
 * positioning values of those axes.
 */
export type CenterMode = 'both' | 'horizontal' | 'vertical';

/**
 * Options for rasterizing text onto a surface.
 */
export interface AddTextOptions {
  /** Text to draw (may contain multiple lines via \n) */
  text: string;
  /**
   * X position of the text origin in pixels or percent of width (default: 0).
   * Ignored when `left` or `right` is set.
   */
  x?: TextLength;
  /**
   * Y position of the text origin in pixels or percent of height (default: 0).
   * Ignored when `top` or `bottom` is set.
   */
  y?: TextLength;
  /**
   * Distance from the surface's left edge to the text block's left edge.
   * Takes precedence over `right` and `x`.
   */
  left?: TextLength;
  /**
   * Distance from the surface's right edge to the text block's right edge
   * (block right = width - right). Takes precedence over `x`.
   */
  right?: TextLength;
  /**
   * Distance from the surface's top edge to the text block's top edge.
   * Takes precedence over `bottom` and `y`.
   */
  top?: TextLength;
  /**
   * Distance from the surface's bottom edge to the text block's bottom edge
   * (block bottom = height - bottom). Takes precedence over `y`.
   */
  bottom?: TextLength;
  /**
   * Center the text block on the given axes, overriding that axis's
   * left/right/x (horizontal) or top/bottom/y (vertical) values. Can be
   * combined with anchoring on the other axis (e.g. center 'horizontal' +
   * bottom '5%'). Only supported in applyText/AddText (needs text measurement).
   */
  center?: CenterMode;
  /**
   * Font size: pixels as number, percent of the surface height ('10%'), or
   * 'auto' to pick the largest size whose text block fits the area left by
   * the positioning margins (only supported in applyText/AddText).
   */
  fontSize: TextLength;
  /**
   * Font family name (default: 'Microsoft YaHei').
   */
  font?: string;
  /**
   * Text color as 0xRRGGBBAA (default: 0xFFFFFFFF).
   */
  color?: number;
  /**
   * Draw with the bold weight (default: false).
   */
  bold?: boolean;
  /**
   * Rebuild mip levels 1..n from the edited mip 0 via 2x2 box downsampling
   * when writing back to a DDS (default: true).
   */
  regenerateMips?: boolean;
}

/**
 * Resolved text layout in pixels.
 */
export interface TextLayout {
  /**
   * Horizontal anchor: block left edge for `left`/`x` mode, block right edge
   * for `right` mode (subtract the measured block width to get the origin).
   */
  x: number;
  /**
   * Vertical anchor: block top edge for `top`/`y` mode, block bottom edge
   * for `bottom` mode (subtract the measured block height to get the origin).
   */
  y: number;
  /** Font size in pixels */
  fontSize: number;
}

/**
 * Default font family used when `options.font` is not specified.
 */
export const DEFAULT_FONT = 'Microsoft YaHei';

/**
 * Resolve a length value (number of pixels or 'N%' string) against a basis
 * dimension. Percentage strings must match `数字%` (e.g. '5%', '12.5%').
 */
function resolveLength(value: TextLength, basis: number, name: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid ${name} value: ${value}`);
    }
    return value;
  }
  if (value.trim() === 'auto') {
    throw new Error(`'auto' ${name} requires text measurement, only supported in applyText/AddText`);
  }
  const match = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid ${name} value: "${value}" (expected a pixel number or a "N%" percentage string)`);
  }
  return (basis * parseFloat(match[1])) / 100;
}

/**
 * Resolve the positioning margins of both axes to pixels (unspecified sides
 * count as 0). Percentages of left/right resolve against `width`, of
 * top/bottom against `height`.
 */
function resolveMargins(width: number, height: number, options: AddTextOptions): { left: number; right: number; top: number; bottom: number } {
  return {
    left: resolveLength(options.left ?? 0, width, 'left'),
    right: resolveLength(options.right ?? 0, width, 'right'),
    top: resolveLength(options.top ?? 0, height, 'top'),
    bottom: resolveLength(options.bottom ?? 0, height, 'bottom'),
  };
}

/**
 * Solve the largest font size (>= 1, within 0.5px) whose text block
 * (max line width x lines * line height) fits into the given budgets.
 * Text metrics scale near-linearly with the font size, so a binary search
 * over `ctx.font` converges in a few rounds.
 */
function solveAutoFontSize(
  ctx: SKRSContext2D,
  lines: string[],
  budgetWidth: number,
  budgetHeight: number,
  makeFont: (size: number) => string,
): number {
  const fits = (size: number): boolean => {
    ctx.font = makeFont(size);
    const m = ctx.measureText('Mg');
    const lineHeight = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    if (lines.length * lineHeight > budgetHeight) return false;
    for (const line of lines) {
      if (ctx.measureText(line).width > budgetWidth) return false;
    }
    return true;
  };

  let lo = 1; // clamped minimum
  let hi = Math.max(budgetWidth, budgetHeight, 1) * 2; // safe upper bound
  // 16 halvings bring the interval below 0.5px for any realistic bound
  for (let i = 0; i < 16 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.max(1, Math.floor(lo));
}

/**
 * Validate a center option and split it into per-axis flags.
 */
function resolveCenter(center: CenterMode | undefined): { horizontal: boolean; vertical: boolean } {
  if (center === undefined) return { horizontal: false, vertical: false };
  if (center === 'both') return { horizontal: true, vertical: true };
  if (center === 'horizontal' || center === 'vertical') return { horizontal: center === 'horizontal', vertical: center === 'vertical' };
  throw new Error(`Invalid center value: "${center}" (expected 'both', 'horizontal' or 'vertical')`);
}

/**
 * Resolve CSS-like text positioning into pixel values (pure function).
 *
 * Axis priority: left > right > x (default 0), top > bottom > y (default 0).
 * Percentages of x/left/right resolve against `width`; of y/top/bottom and
 * fontSize against `height`. For `right`/`bottom` the returned coordinate is
 * the block's right/bottom edge; callers subtract the measured block size to
 * get the drawing origin. Rejects `fontSize: 'auto'` and `center` (both need
 * text measurement, only supported in applyText/AddText).
 *
 * @param width - Surface width in pixels
 * @param height - Surface height in pixels
 * @param options - Text options carrying the position/size values
 */
export function resolveTextLayout(width: number, height: number, options: AddTextOptions): TextLayout {
  if (options.center !== undefined) {
    resolveCenter(options.center); // validate, then reject below like 'auto'
    throw new Error(`'center' requires text measurement, only supported in applyText/AddText`);
  }
  const fontSize = resolveLength(options.fontSize, height, 'fontSize');

  let x: number;
  if (options.left !== undefined) {
    x = resolveLength(options.left, width, 'left');
  } else if (options.right !== undefined) {
    x = width - resolveLength(options.right, width, 'right');
  } else {
    x = resolveLength(options.x ?? 0, width, 'x');
  }

  let y: number;
  if (options.top !== undefined) {
    y = resolveLength(options.top, height, 'top');
  } else if (options.bottom !== undefined) {
    y = height - resolveLength(options.bottom, height, 'bottom');
  } else {
    y = resolveLength(options.y ?? 0, height, 'y');
  }

  return { x, y, fontSize };
}

/**
 * Input of applyText/AddText: a single options object, or an array of them
 * drawn sequentially onto the same canvas (later entries paint over earlier
 * ones; entries may overlap - no collision avoidance is performed).
 */
export type AddTextInput = AddTextOptions | AddTextOptions[];

/**
 * Rasterize text onto a copy of the surface using @napi-rs/canvas and return
 * the result as a new RgbaSurface. The input surface is not modified.
 *
 * Text is rendered line by line ('\n' splits lines). The block's top-left
 * corner is derived from the CSS-like positioning rules (left/right/x and
 * top/bottom/y, see {@link resolveTextLayout}); `right`/`bottom` anchor the
 * block's far edge after measuring its extent. A `fontSize` of 'auto' picks
 * the largest size whose block fits the area left by the margins. `center`
 * centers the block on the given axes, overriding their anchors (a centered
 * axis contributes its full length to the 'auto' budget).
 *
 * An array of options draws all entries sequentially on the same canvas,
 * each with its own positioning/font size; 'auto' budgets are per-entry
 * against the full image (entries may overlap). An empty array returns a
 * copy of the input.
 *
 * The text is drawn on a fully transparent canvas layer which is then
 * source-over composited manually: round-tripping the base image through
 * putImageData/getImageData would rewrite every translucent base pixel
 * (premultiplied-alpha rounding). With this approach pixels outside the
 * text ink stay byte-identical to the input (including translucent ones);
 * antialiased text edges may differ by +-1 from a native composition due to
 * the un-premultiplication performed by getImageData.
 *
 * @param surface - Base image the text is drawn over
 * @param options - Text content, position, style (single entry or array)
 */
export function applyText(surface: RgbaSurface, options: AddTextInput): RgbaSurface {
  const entries = Array.isArray(options) ? options : [options];
  if (entries.length === 0) {
    return new RgbaSurface(surface.width, surface.height, new Uint8Array(surface.pixels));
  }

  // Text layer: a fully transparent canvas (no putImageData of the base image)
  const canvas = loadCanvas().createCanvas(surface.width, surface.height);
  const ctx = canvas.getContext('2d');
  for (const entry of entries) {
    drawTextBlock(ctx, surface.width, surface.height, entry);
  }
  const text = ctx.getImageData(0, 0, surface.width, surface.height).data;

  // Manual source-over composition of the text layer (straight alpha) onto
  // the untouched base pixels: outA = srcA + dstA*(1-srcA/255);
  // outC = (srcC*srcA + dstC*dstA*(1-srcA/255)) / outA
  const out = new Uint8Array(surface.pixels);
  for (let i = 0; i < out.length; i += 4) {
    const srcA = text[i + 3];
    if (srcA === 0) continue; // no text ink: base pixel stays byte-identical
    const dstA = out[i + 3];
    const inv = 1 - srcA / 255;
    const outA = srcA + dstA * inv; // srcA > 0 keeps outA > 0
    out[i] = Math.round((text[i] * srcA + out[i] * dstA * inv) / outA);
    out[i + 1] = Math.round((text[i + 1] * srcA + out[i + 1] * dstA * inv) / outA);
    out[i + 2] = Math.round((text[i + 2] * srcA + out[i + 2] * dstA * inv) / outA);
    out[i + 3] = Math.round(outA);
  }
  return new RgbaSurface(surface.width, surface.height, out);
}

/**
 * Draw one text block onto an existing canvas context (used by
 * {@link applyText}; the caller manages getImageData of the text layer).
 *
 * @param ctx - Canvas context to draw on
 * @param width - Surface width in pixels
 * @param height - Surface height in pixels
 * @param options - Text content, position, style of this block
 */
function drawTextBlock(ctx: SKRSContext2D, width: number, height: number, options: AddTextOptions): void {
  const color = options.color ?? 0xffffffff;
  const r = (color >>> 24) & 0xff;
  const g = (color >>> 16) & 0xff;
  const b = (color >>> 8) & 0xff;
  const a = color & 0xff;
  const font = options.font ?? DEFAULT_FONT;
  const lines = options.text.split('\n');
  const makeFont = (size: number): string => `${options.bold ? 'bold ' : ''}${size}px "${font}"`;
  const center = resolveCenter(options.center);

  // Resolve 'auto' fontSize first: the available-area budgets depend only on
  // the positioning margins, not on the font size itself. Centered axes span
  // the full surface length (their margins are overridden and don't count).
  let effectiveOptions = options;
  if (typeof options.fontSize === 'string' && options.fontSize.trim() === 'auto') {
    const margins = resolveMargins(width, height, options);
    const budgetWidth = center.horizontal ? width : Math.max(1, width - margins.left - margins.right);
    const budgetHeight = center.vertical ? height : Math.max(1, height - margins.top - margins.bottom);
    const solved = solveAutoFontSize(ctx, lines, budgetWidth, budgetHeight, makeFont);
    effectiveOptions = { ...options, fontSize: solved };
  }
  // Centered axes override their anchors at origin computation below; strip
  // `center` so the pure layout resolver only handles the remaining axes
  const { center: _center, ...optionsWithoutCenter } = effectiveOptions;

  const layout = resolveTextLayout(width, height, optionsWithoutCenter);

  ctx.font = makeFont(layout.fontSize);
  ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
  ctx.textBaseline = 'top';

  // Measure the block extent with the applied font
  const metrics = ctx.measureText('Mg');
  const lineHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const lineMetrics = lines.map((line) => ctx.measureText(line));
  const blockWidth = lineMetrics.reduce((max, m) => Math.max(max, m.width), 0);
  const blockHeight = lines.length * lineHeight;

  // Ink extents (actual glyph coverage) relative to the drawing origin, used
  // for visual centering: a font's bounding box towers over the real glyphs
  // (e.g. uppercase-only lines have no descent), so centering the geometric
  // block would look shifted. With textBaseline 'top' the metrics reported by
  // measureText are relative to the top line (the drawing origin): ink spans
  // from -actualBoundingBoxAscent down to actualBoundingBoxDescent, and from
  // actualBoundingBoxLeft to actualBoundingBoxRight. Lines with no ink (all
  // actualBoundingBox values 0, e.g. empty lines) are skipped.
  const hasInk = (m: { actualBoundingBoxAscent: number; actualBoundingBoxDescent: number }): boolean =>
    m.actualBoundingBoxAscent !== 0 || m.actualBoundingBoxDescent !== 0;
  const inkTop = Math.min(...lineMetrics.map((m, i) => (hasInk(m) ? i * lineHeight - m.actualBoundingBoxAscent : Infinity)));
  const inkBottom = Math.max(...lineMetrics.map((m, i) => (hasInk(m) ? i * lineHeight + m.actualBoundingBoxDescent : -Infinity)));
  const inkLeft = Math.min(...lineMetrics.map((m) => (hasInk(m) ? m.actualBoundingBoxLeft : Infinity)));
  const inkRight = Math.max(...lineMetrics.map((m) => (hasInk(m) ? m.actualBoundingBoxRight : -Infinity)));
  const inkKnown = inkTop !== Infinity && inkBottom !== -Infinity && inkLeft !== Infinity && inkRight !== -Infinity;

  // Centered axes place the ink symmetrically (highest priority); other axes
  // shift the anchor back by the block extent for right/bottom anchoring
  const originX = center.horizontal && inkKnown
    ? (width - (inkRight - inkLeft)) / 2 - inkLeft
    : center.horizontal
      ? (width - blockWidth) / 2
      : options.left === undefined && options.right !== undefined
        ? layout.x - blockWidth
        : layout.x;
  const originY = center.vertical && inkKnown
    ? (height - (inkBottom - inkTop)) / 2 - inkTop
    : center.vertical
      ? (height - blockHeight) / 2
      : options.top === undefined && options.bottom !== undefined
        ? layout.y - blockHeight
        : layout.y;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], originX, originY + i * lineHeight);
  }
}
