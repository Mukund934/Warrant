import { describe, expect, it } from "vitest";
import { canonicalJson, digestOf, WarrantError } from "../src/index.js";

describe("canonical serialisation", () => {
  it("orders object keys by UTF-16 code unit", () => {
    const output = canonicalJson({ b: 1, a: 2, C: 3, "1": 4 });
    expect(output).toBe('{"1":4,"C":3,"a":2,"b":1}');
  });

  it("orders keys the same way at every depth", () => {
    const output = canonicalJson({ outer: { z: 1, a: { y: 1, b: 2 } } });
    expect(output).toBe('{"outer":{"a":{"b":2,"y":1},"z":1}}');
  });

  it("places control characters before digits and digits before letters", () => {
    const output = canonicalJson({
      "€": "euro",
      "\r": "carriage return",
      "\n": "newline",
      "1": "one",
      "ö": "o with diaeresis",
    });
    const positions = ["\\n", "\\r", '"1"', "ö", "€"].map((token) => output.indexOf(token));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
  });

  it("preserves array order", () => {
    expect(canonicalJson({ items: ["b", "a", "c"] })).toBe('{"items":["b","a","c"]}');
  });

  it("produces the same bytes regardless of the order keys were written in", async () => {
    const first = { alpha: 1, beta: { gamma: [1, 2], delta: "x" } };
    const second = { beta: { delta: "x", gamma: [1, 2] }, alpha: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(await digestOf(first)).toBe(await digestOf(second));
  });

  it("drops undefined properties consistently on both sides", async () => {
    expect(await digestOf({ a: 1, b: undefined })).toBe(await digestOf({ a: 1 }));
  });

  it("round-trips through JSON.parse without loss", () => {
    const value = { z: [{ b: null, a: true }], "": "empty key", nested: { "é": 1 } };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });

  it("refuses non-finite numbers rather than emitting null", () => {
    expect(() => canonicalJson({ amount: Number.POSITIVE_INFINITY })).toThrow(WarrantError);
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(WarrantError);
  });

  it("produces a sha256 base64url digest", async () => {
    const digest = await digestOf({ a: 1 });
    expect(digest).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });
});
