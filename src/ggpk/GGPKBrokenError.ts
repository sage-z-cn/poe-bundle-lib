/**
 * Error thrown when the GGPK file has an invalid record tag,
 * indicating corruption or an unexpected format version.
 */
export class GGPKBrokenError extends Error {
  /**
   * The GGPK instance where the error occurred.
   */
  readonly ggpk: unknown; // Avoid circular import; cast to GGPK at use-site.

  /**
   * The file offset (in bytes) at which the invalid tag was encountered.
   */
  readonly offset: number;

  /**
   * The raw tag value read from the file.
   */
  readonly tag: number;

  constructor(ggpk: unknown, message: string, offset: number, tag: number) {
    super(message);
    this.name = 'GGPKBrokenError';
    this.ggpk = ggpk;
    this.offset = offset;
    this.tag = tag;
  }
}
