import {
  createTiktokenEncoder,
  countTokensTiktoken,
  countTokensHeuristic,
  TOKEN_BUDGET_FACTOR,
} from "./token-counting.js";

describe("token-counting", () => {
  describe("TOKEN_BUDGET_FACTOR", () => {
    it("is 0.95", () => {
      expect(TOKEN_BUDGET_FACTOR).toBe(0.95);
    });
  });

  describe("createTiktokenEncoder", () => {
    it("creates encoder for known model", () => {
      const encoder = createTiktokenEncoder("text-embedding-3-small");
      expect(encoder).toBeDefined();
      expect(encoder.encode("hello")).toEqual(expect.any(Array));
    });

    it("falls back to cl100k_base for unknown model", () => {
      const encoder = createTiktokenEncoder("unknown-model-xyz");
      expect(encoder).toBeDefined();
      expect(encoder.encode("hello")).toEqual(expect.any(Array));
    });
  });

  describe("countTokensTiktoken", () => {
    it("returns correct token count for known input", () => {
      const encoder = createTiktokenEncoder("text-embedding-3-small");
      // "hello world" is 2 tokens in cl100k_base
      expect(countTokensTiktoken(encoder, "hello world")).toBe(2);
    });

    it("returns 0 for empty string", () => {
      const encoder = createTiktokenEncoder("text-embedding-3-small");
      expect(countTokensTiktoken(encoder, "")).toBe(0);
    });

    it("counts multi-token words correctly", () => {
      const encoder = createTiktokenEncoder("text-embedding-3-small");
      // "unconstitutional" is multiple tokens in cl100k_base
      const count = countTokensTiktoken(encoder, "unconstitutional");
      expect(count).toBeGreaterThan(1);
    });
  });

  describe("countTokensHeuristic", () => {
    it("estimates tokens at 3.5 chars/token", () => {
      // 35 chars / 3.5 = 10 tokens
      const text = "a".repeat(35);
      expect(countTokensHeuristic(text, 3.5)).toBe(10);
    });

    it("estimates tokens at 4 chars/token", () => {
      // 40 chars / 4 = 10 tokens
      const text = "a".repeat(40);
      expect(countTokensHeuristic(text, 4)).toBe(10);
    });

    it("rounds up partial tokens", () => {
      // 7 chars / 4 = 1.75 → 2
      expect(countTokensHeuristic("abcdefg", 4)).toBe(2);
    });

    it("returns 0 for empty string", () => {
      expect(countTokensHeuristic("", 4)).toBe(0);
    });
  });
});
