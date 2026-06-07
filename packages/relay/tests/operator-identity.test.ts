import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/operator-identity";

describe("canonicalize", () => {
  it("sorts object keys and strips insignificant whitespace", () => {
    const out = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    expect(out).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("is independent of input key order", () => {
    const a = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order and handles primitives", () => {
    expect(canonicalize({ xs: [3, 1, 2], n: null, s: "hi" })).toBe(
      '{"n":null,"s":"hi","xs":[3,1,2]}'
    );
  });
});
