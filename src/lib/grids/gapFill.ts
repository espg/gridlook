/**
 * Fills the blank cells of a scalar field on a regular grid from the cells
 * around them, by normalised convolution with a Gaussian kernel:
 * `conv(value · mask) / conv(mask)`, where `mask` is 1 on a cell with data.
 * A cell with data keeps its value; a blank cell (NaN) takes the convolved
 * one, and stays blank when no cell under the kernel has data.
 *
 * The same result is computed two ways, to compare: directly (the kernel is
 * separable, so two passes of `size` taps) and through a radix-2 FFT of the
 * field zero-padded by the kernel radius to a power of two. Beyond the grid
 * there is no data: nothing wraps around.
 */

export const GAP_FILL_METHODS = { DIRECT: "direct", FFT: "fft" } as const;
export type TGapFillMethod =
  (typeof GAP_FILL_METHODS)[keyof typeof GAP_FILL_METHODS];

/** The method used; the other one is kept to compare against. */
const GAP_FILL_METHOD: TGapFillMethod = GAP_FILL_METHODS.DIRECT;

/** Kernel sizes offered, in cells across. */
export const GAP_FILL_SIZES = [3, 5, 7, 9, 15, 31] as const;
export const DEFAULT_GAP_FILL_SIZE = 5;

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

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddlesOf(length: number) {
  let table = twiddles.get(length);
  if (!table) {
    table = {
      cos: Float64Array.from({ length: length / 2 }, (_, k) =>
        Math.cos((2 * Math.PI * k) / length)
      ),
      sin: Float64Array.from({ length: length / 2 }, (_, k) =>
        Math.sin((2 * Math.PI * k) / length)
      ),
    };
    twiddles.set(length, table);
  }
  return table;
}

/**
 * The discrete Fourier transform of `length` complex numbers (a power of
 * two) starting at `offset`, in place; unscaled either way.
 */
function fft(
  re: Float64Array,
  im: Float64Array,
  offset: number,
  length: number,
  inverse: boolean
) {
  for (let i = 1, j = 0; i < length; i++) {
    let bit = length >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const a = offset + i;
      const b = offset + j;
      [re[a], re[b]] = [re[b], re[a]];
      [im[a], im[b]] = [im[b], im[a]];
    }
  }
  const { cos, sin } = twiddlesOf(length);
  const sign = inverse ? 1 : -1;
  for (let half = 1; half < length; half *= 2) {
    const stride = length / (2 * half);
    for (let start = offset; start < offset + length; start += 2 * half) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sign * sin[k * stride];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** The transform of every row, then of every column, of a padded field. */
function fft2d(
  re: Float64Array,
  im: Float64Array,
  width: number,
  height: number,
  inverse: boolean
) {
  for (let row = 0; row < height; row++) {
    fft(re, im, row * width, width, inverse);
  }
  const columnRe = new Float64Array(height);
  const columnIm = new Float64Array(height);
  for (let column = 0; column < width; column++) {
    for (let row = 0; row < height; row++) {
      columnRe[row] = re[row * width + column];
      columnIm[row] = im[row * width + column];
    }
    fft(columnRe, columnIm, 0, height, inverse);
    for (let row = 0; row < height; row++) {
      re[row * width + column] = columnRe[row];
      im[row * width + column] = columnIm[row];
    }
  }
}

/** The spectrum of the kernel on a ring of `length`; real, as it is even. */
function kernelSpectrum(taps: Float64Array, length: number) {
  const radius = (taps.length - 1) / 2;
  const re = new Float64Array(length);
  const im = new Float64Array(length);
  for (let k = -radius; k <= radius; k++) {
    re[(k + length) % length] += taps[k + radius];
  }
  fft(re, im, 0, length, false);
  return re;
}

function paddedLength(length: number, radius: number) {
  return 2 ** Math.ceil(Math.log2(length + radius));
}

/**
 * The same convolution through the FFT. The value and the mask are the real
 * and the imaginary part of one field, as the kernel is real: one transform
 * each way convolves both.
 */
function convolveFft(
  value: Float64Array,
  mask: Float64Array,
  size: { width: number; height: number },
  taps: Float64Array
) {
  const radius = (taps.length - 1) / 2;
  const width = paddedLength(size.width, radius);
  const height = paddedLength(size.height, radius);
  const re = new Float64Array(width * height);
  const im = new Float64Array(width * height);
  for (let row = 0; row < size.height; row++) {
    const from = row * size.width;
    re.set(value.subarray(from, from + size.width), row * width);
    im.set(mask.subarray(from, from + size.width), row * width);
  }
  fft2d(re, im, width, height, false);
  const kernelX = kernelSpectrum(taps, width);
  const kernelY = kernelSpectrum(taps, height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const gain = (kernelX[column] * kernelY[row]) / (width * height);
      re[row * width + column] *= gain;
      im[row * width + column] *= gain;
    }
  }
  fft2d(re, im, width, height, true);
  for (let row = 0; row < size.height; row++) {
    const from = row * width;
    value.set(re.subarray(from, from + size.width), row * size.width);
    mask.set(im.subarray(from, from + size.width), row * size.width);
  }
}

/**
 * `values` (row-major, `width` across) with its blank cells filled from the
 * data under a Gaussian kernel `size` cells across; cells with data are
 * returned as they are.
 */
export function fillGaps(
  values: Float32Array,
  width: number,
  size: number,
  method: TGapFillMethod = GAP_FILL_METHOD
) {
  const value = new Float64Array(values.length);
  const mask = new Float64Array(values.length);
  for (let index = 0; index < values.length; index++) {
    if (!Number.isNaN(values[index])) {
      value[index] = values[index];
      mask[index] = 1;
    }
  }
  const taps = gaussianTaps(size);
  const convolve =
    method === GAP_FILL_METHODS.FFT ? convolveFft : convolveDirect;
  convolve(value, mask, { width, height: values.length / width }, taps);
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
