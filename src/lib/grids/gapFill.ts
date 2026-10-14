/**
 * Fills the blank cells of a scalar field on a regular grid from the cells
 * around them, by normalised convolution with a Gaussian kernel:
 * `conv(value · mask) / conv(mask)`, where `mask` is 1 on a cell with data.
 * A cell with data keeps its value; a blank cell (NaN) takes the convolved
 * one, and stays blank when no cell under the kernel has data.
 *
 * Computed directly: the kernel is separable, so two passes of `size` taps.
 * (An FFT version was measured against it on fields of 64² to 2048² and
 * kernels of 3 to 31 taps and lost at every size a view produces; a direct
 * pass over a view's face box, 100 to 150 cells across, is under 3 ms.)
 * Beyond the grid there is no data: nothing wraps around.
 */

/** Kernel sizes offered, in cells across. */
export const GAP_FILL_SIZES = [3, 5, 7, 9, 15, 31] as const;
export const DEFAULT_GAP_FILL_SIZE = 15;

/**
 * The standard deviation, in cells, of a kernel `size` cells across: the
 * kernel reaches three of them either way, `size = 2 · ceil(3σ) + 1`.
 */
export function gaussianSigma(size: number) {
  return (size - 1) / 6;
}

/** The taps of the kernel along one axis; they sum to 1. */
function gaussianTaps(size: number) {
  const radius = (size - 1) / 2;
  const sigma = gaussianSigma(size);
  const taps = Float64Array.from({ length: size }, (_, index) =>
    Math.exp(-((index - radius) ** 2) / (2 * sigma * sigma))
  );
  const total = taps.reduce((sum, tap) => sum + tap, 0);
  return taps.map((tap) => tap / total);
}

/** One pass of the kernel along the rows (`step` 1) or the columns. */
function convolveAxis(
  source: Float64Array,
  target: Float64Array,
  size: { width: number; height: number },
  taps: Float64Array,
  alongRows: boolean
) {
  const radius = (taps.length - 1) / 2;
  const length = alongRows ? size.width : size.height;
  const lines = alongRows ? size.height : size.width;
  const step = alongRows ? 1 : size.width;
  const lineStep = alongRows ? size.width : 1;
  for (let line = 0; line < lines; line++) {
    const origin = line * lineStep;
    for (let at = 0; at < length; at++) {
      const from = Math.max(at - radius, 0);
      const to = Math.min(at + radius, length - 1);
      let total = 0;
      for (let k = from; k <= to; k++) {
        total += source[origin + k * step] * taps[k - at + radius];
      }
      target[origin + at * step] = total;
    }
  }
}

/** The direct convolution of the value and the mask fields. */
function convolveDirect(
  value: Float64Array,
  mask: Float64Array,
  size: { width: number; height: number },
  taps: Float64Array
) {
  const scratch = new Float64Array(value.length);
  for (const field of [value, mask]) {
    convolveAxis(field, scratch, size, taps, true);
    convolveAxis(scratch, field, size, taps, false);
  }
}

/**
 * `values` (row-major, `width` across) with its blank cells filled from the
 * data under a Gaussian kernel `size` cells across; cells with data are
 * returned as they are.
 */
export function fillGaps(values: Float32Array, width: number, size: number) {
  const value = new Float64Array(values.length);
  const mask = new Float64Array(values.length);
  for (let index = 0; index < values.length; index++) {
    if (!Number.isNaN(values[index])) {
      value[index] = values[index];
      mask[index] = 1;
    }
  }
  const taps = gaussianTaps(size);
  convolveDirect(value, mask, { width, height: values.length / width }, taps);
  // the least weight one cell with data gives: the corner of the kernel.
  // Half of it tells that from the rounding of a transform.
  const support = (taps[0] * taps[0]) / 2;
  const filled = new Float32Array(values);
  for (let index = 0; index < values.length; index++) {
    if (Number.isNaN(values[index]) && mask[index] > support) {
      filled[index] = value[index] / mask[index];
    }
  }
  return filled;
}
