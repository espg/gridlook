import { MAX_ORDER, wordToNested } from "@/lib/morton/word.ts";

/**
 * Point words to NESTED ids at order 29, by the thousand. A located digest
 * gives one order-29 point word per centroid (mortie spec v1.0 section 1:
 * `[4-bit prefix][54-bit body][6-bit suffix]`, suffix 48..63 the point
 * region). `wordToNested` decodes any word, through BigInt arithmetic; a
 * chunk holds thousands of point words, so they are decoded here on their
 * two uint32 halves instead, the body shifted right by two and the base
 * cell and the order-28/29 tuples moved into place:
 *
 *     nested = (prefix − 1) << 58 | (word >> 2) & bits 4..57 | suffix − 48
 *
 * A word that is not a point (a lossy centroid carries the area word of its
 * members' common ancestor, at a coarser order) is left to `wordToNested`.
 */

/** First suffix value of the order-29 point region. */
const POINT_BASE = 48;
const SUFFIX_MASK = 63;
/** `nested` bits 32..57 within the high word, after the shift. */
const BODY_HIGH_MASK = 0x03ffffff;

export type TNestedWords = {
  /** NESTED ids at `orders[i]`, one per word. */
  nested: BigUint64Array;
  /** The order of each id: 29 for a point word, less for an area word. */
  orders: Uint8Array;
};

/**
 * Decode every word of a chunk. `words` is read in place; the result is
 * fresh. Little-endian: the low half of word `i` is `halves[2i]`.
 */
export function wordsToNested(words: BigUint64Array): TNestedWords {
  const count = words.length;
  const halves = new Uint32Array(words.buffer, words.byteOffset, 2 * count);
  const nested = new BigUint64Array(count);
  const out = new Uint32Array(nested.buffer);
  const orders = new Uint8Array(count).fill(MAX_ORDER);
  for (let i = 0; i < count; i++) {
    const lo = halves[2 * i];
    const hi = halves[2 * i + 1];
    const suffix = lo & SUFFIX_MASK;
    const prefix = (hi >>> 28) & 0xf;
    if (suffix < POINT_BASE || prefix < 1 || prefix > 12) {
      // an area word, or an empty/invalid one: the general decoder
      const decoded = wordToNested(words[i]);
      nested[i] = decoded.nested;
      orders[i] = decoded.order;
      continue;
    }
    out[2 * i] = (((lo >>> 2) | (hi << 30)) & ~0xf) | (suffix - POINT_BASE);
    out[2 * i + 1] = ((hi >>> 2) & BODY_HIGH_MASK) | ((prefix - 1) << 26);
  }
  return { nested, orders };
}
