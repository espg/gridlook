/**
 * One decoded chunk of a zarr `vlen-bytes` array (the wire format of zagg's
 * ragged arrays, spec `zagg-ragged/1`): `u32 n_items`, then per item a
 * `u32 length` and that many bytes, all little-endian. Item `i` is
 * `bytes[offsets[i] .. offsets[i + 1])`; an empty item is a cell without
 * data. The payloads are copied into one buffer, never one array per item.
 */
export type TVlenChunk = {
  /** `items + 1` byte offsets into `bytes`. */
  offsets: Uint32Array;
  bytes: Uint8Array;
};

const LENGTH_BYTES = 4;

export function decodeVlenChunk(frame: Uint8Array): TVlenChunk {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (frame.byteLength < LENGTH_BYTES) {
    throw new Error("vlen-bytes chunk is shorter than its item count");
  }
  const items = view.getUint32(0, true);
  const payload = frame.byteLength - LENGTH_BYTES * (items + 1);
  if (payload < 0) {
    throw new Error(`vlen-bytes chunk is too short for ${items} items`);
  }
  const offsets = new Uint32Array(items + 1);
  const bytes = new Uint8Array(payload);
  let read = LENGTH_BYTES;
  let written = 0;
  for (let item = 0; item < items; item++) {
    const length = view.getUint32(read, true);
    read += LENGTH_BYTES;
    if (written + length > payload) {
      throw new Error(`vlen-bytes item ${item} runs past the chunk`);
    }
    bytes.set(frame.subarray(read, read + length), written);
    read += length;
    written += length;
    offsets[item + 1] = written;
  }
  if (written !== payload) {
    throw new Error("vlen-bytes chunk has bytes after its last item");
  }
  return { offsets, bytes };
}
