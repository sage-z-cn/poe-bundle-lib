import { DdsImage } from './DdsImage.js';
import { applyText } from './TextLayer.js';
import type { AddTextInput, AddTextOptions } from './TextLayer.js';

/**
 * AddText - rasterize text onto mip 0 of an uncompressed RGBA8 DDS texture
 * and return the new complete DDS buffer.
 *
 * Accepts a single options object or an array of them (drawn sequentially,
 * each with its own positioning; entries may overlap). Mip levels 1..n are
 * rebuilt from the edited mip 0 (2x2 box downsampling) unless the relevant
 * entry sets `regenerateMips: false` (defaults to true).
 *
 * @param ddsBuffer - Content of the source *.dds file
 * @param options - Text content, position and style (single entry or array)
 */
export function AddText(ddsBuffer: Buffer, options: AddTextInput): Buffer {
  const image = DdsImage.parse(ddsBuffer);
  const edited = applyText(image.decodeMip(0), options);
  // Any entry may opt out; default true
  const regenerate = Array.isArray(options) ? options.every((o) => o.regenerateMips ?? true) : (options as AddTextOptions).regenerateMips ?? true;
  return image.writeMipPixels(0, edited.pixels, regenerate);
}
