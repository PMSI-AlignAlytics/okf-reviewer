import { describe, expect, it } from "vitest";
import {
  gitModifiedDirectoryIds,
  gitReviewDirectoryStates,
} from "@/features/navigation/components/IndexTree.tsx";

describe("Git-modified directory propagation", () => {
  it("marks every ancestor folder and ignores root-level concepts", () => {
    expect(gitModifiedDirectoryIds([
      "guides/platform/windows/setup",
      "guides/overview",
      "root-concept",
    ])).toEqual(new Set(["guides/platform/windows", "guides/platform", "guides"]));
  });

  it("separates pending and reviewed modified descendants", () => {
    const states = gitReviewDirectoryStates(
      [
        "guides/platform/windows/setup",
        "guides/reference",
        "archive/complete",
        "root-concept",
      ],
      new Set(["guides/reference", "archive/complete"]),
    );

    expect(states.needsReview).toEqual(
      new Set(["guides/platform/windows", "guides/platform", "guides"]),
    );
    expect(states.reviewed).toEqual(new Set(["guides", "archive"]));
  });
});
