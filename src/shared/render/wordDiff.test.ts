import { describe, expect, it } from "vitest";
import { condenseDiff, diffWords, hasWordChanges } from "@/shared/render/wordDiff.ts";

describe("diffWords", () => {
  it("isolates a one-word edit inside a long paragraph", () => {
    const before = "The reviewer records a verification event after reading the whole concept carefully.";
    const after = "The reviewer records a verification event after reading the entire concept carefully.";

    expect(diffWords(before, after)).toEqual([
      { kind: "same", text: "The reviewer records a verification event after reading the " },
      { kind: "removed", text: "whole " },
      { kind: "added", text: "entire " },
      { kind: "same", text: "concept carefully." },
    ]);
  });

  it("reports a run of edits as removed text followed by added text", () => {
    expect(diffWords("the quick brown fox", "the slow red fox")).toEqual([
      { kind: "same", text: "the " },
      { kind: "removed", text: "quick brown " },
      { kind: "added", text: "slow red " },
      { kind: "same", text: "fox" },
    ]);
  });

  it("keeps unchanged words between separate edits", () => {
    expect(diffWords("alpha beta gamma delta", "alpha BETA gamma DELTA")).toEqual([
      { kind: "same", text: "alpha " },
      { kind: "removed", text: "beta " },
      { kind: "added", text: "BETA " },
      { kind: "same", text: "gamma " },
      { kind: "removed", text: "delta" },
      { kind: "added", text: "DELTA" },
    ]);
  });

  it("treats re-wrapped lines as unchanged and reports the current whitespace", () => {
    const parts = diffWords("one two\nthree four", "one two three\nfour");

    expect(parts).toEqual([{ kind: "same", text: "one two three\nfour" }]);
    expect(hasWordChanges(parts)).toBe(false);
  });

  it("reports pure insertions and deletions", () => {
    expect(diffWords("keep this", "keep all of this")).toEqual([
      { kind: "same", text: "keep " },
      { kind: "added", text: "all of " },
      { kind: "same", text: "this" },
    ]);
    expect(diffWords("keep all of this", "keep this")).toEqual([
      { kind: "same", text: "keep " },
      { kind: "removed", text: "all of " },
      { kind: "same", text: "this" },
    ]);
    expect(diffWords("", "new text")).toEqual([{ kind: "added", text: "new text" }]);
  });

  it("keeps Markdown syntax attached to its word", () => {
    expect(diffWords(
      "See [reader](concept-reader.md) for details.",
      "See [reader](reader.md) for details.",
    )).toEqual([
      { kind: "same", text: "See " },
      { kind: "removed", text: "[reader](concept-reader.md) " },
      { kind: "added", text: "[reader](reader.md) " },
      { kind: "same", text: "for details." },
    ]);
  });

  it("reports an oversized rewrite as one replacement without building the full table", () => {
    const before = Array.from({ length: 1_200 }, (_, i) => `old${i}`).join(" ");
    const after = Array.from({ length: 1_200 }, (_, i) => `new${i}`).join(" ");

    expect(diffWords(before, after)).toEqual([
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ]);
  });
});

describe("condenseDiff", () => {
  const words = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");

  it("keeps a few words of context around each change", () => {
    const before = `${words("a", 20)} old ${words("z", 20)}`;
    const after = `${words("a", 20)} new ${words("z", 20)}`;

    expect(condenseDiff(diffWords(before, after), 3)).toEqual([
      { kind: "elided" },
      { kind: "same", text: "a17 a18 a19 " },
      { kind: "removed", text: "old " },
      { kind: "added", text: "new " },
      { kind: "same", text: "z0 z1 z2 " },
      { kind: "elided" },
    ]);
  });

  it("elides only long unchanged runs between changes", () => {
    const parts = diffWords(
      `x ${words("m", 10)} y`,
      `X ${words("m", 10)} Y`,
    );

    expect(condenseDiff(parts, 2)).toEqual([
      { kind: "removed", text: "x " },
      { kind: "added", text: "X " },
      { kind: "same", text: "m0 m1 " },
      { kind: "elided" },
      { kind: "same", text: "m8 m9 " },
      { kind: "removed", text: "y" },
      { kind: "added", text: "Y" },
    ]);
    expect(condenseDiff(parts, 5)).toEqual(parts);
  });

  it("leaves text without word changes whole", () => {
    const parts = diffWords("same text", "same text");
    expect(condenseDiff(parts, 1)).toEqual(parts);
  });
});
