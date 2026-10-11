import { describe, expect, it } from "vitest";

import { parseMortonDecimal } from "@/lib/morton/decimal.ts";
import { MAX_ORDER, wordToNested } from "@/lib/morton/word.ts";
import { wordsToNested } from "@/lib/points/pointWords.ts";

/** A reproducible stream of numbers in [0, 1). */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

/** A random decimal morton id at `order`, a point when `point`. */
function randomId(next: () => number, order: number, point: boolean) {
  const base = `${next() < 0.5 ? "-" : ""}${1 + Math.floor(next() * 6)}`;
  const tail = Array.from({ length: order }, () =>
    String(1 + Math.floor(next() * 4))
  ).join("");
  return `${base}${tail}${point ? "p" : ""}`;
}

// eslint-disable-next-line max-lines-per-function
describe("wordsToNested", () => {
  it("matches wordToNested on random order-29 point words", () => {
    const next = random(29);
    const words = BigUint64Array.from({ length: 2000 }, () =>
      parseMortonDecimal(randomId(next, MAX_ORDER, true))
    );
    const { nested, orders } = wordsToNested(words);
    for (let i = 0; i < words.length; i++) {
      const expected = wordToNested(words[i]);
      expect(nested[i]).toBe(expected.nested);
      expect(orders[i]).toBe(MAX_ORDER);
      expect(expected.order).toBe(MAX_ORDER);
    }
  });

  it("decodes every base cell and every suffix of the point region", () => {
    for (const base of ["1", "2", "3", "4", "5", "6", "-1", "-3", "-6"]) {
      for (const t28 of ["1", "2", "3", "4"]) {
        for (const t29 of ["1", "2", "3", "4"]) {
          const id = `${base}${"1234".repeat(6)}123${t28}${t29}p`;
          const word = parseMortonDecimal(id);
          const { nested, orders } = wordsToNested(BigUint64Array.of(word));
          expect(nested[0]).toBe(wordToNested(word).nested);
          expect(orders[0]).toBe(MAX_ORDER);
        }
      }
    }
  });

  it("hands area words (lossy centroids) to the general decoder, in place", () => {
    const next = random(7);
    const ids = Array.from({ length: 300 }, (_, i) =>
      i % 3 === 0
        ? randomId(next, 1 + Math.floor(next() * MAX_ORDER), false)
        : randomId(next, MAX_ORDER, true)
    );
    const words = BigUint64Array.from(ids, parseMortonDecimal);
    const { nested, orders } = wordsToNested(words);
    ids.forEach((id, i) => {
      const expected = wordToNested(words[i]);
      expect(nested[i]).toBe(expected.nested);
      expect(orders[i]).toBe(expected.order);
      expect(orders[i] === MAX_ORDER || !id.endsWith("p")).toBe(true);
    });
  });

  it("leaves the words it reads untouched and refuses an empty word", () => {
    const word = parseMortonDecimal(`3${"4".repeat(29)}p`);
    const words = BigUint64Array.of(word, word);
    wordsToNested(words);
    expect(words[0]).toBe(word);
    expect(words[1]).toBe(word);
    expect(() => wordsToNested(BigUint64Array.of(0n))).toThrow(RangeError);
  });
});
