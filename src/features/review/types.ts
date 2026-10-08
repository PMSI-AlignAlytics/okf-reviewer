export type ReviewProblemCode =
  | "access-denied"
  | "invalid-path"
  | "missing-concept"
  | "too-large"
  | "invalid-utf8"
  | "missing-frontmatter"
  | "malformed-frontmatter"
  | "missing-type"
  | "invalid-status"
  | "malformed-verified"
  | "invalid-reviewer"
  | "invalid-timestamp"
  | "deprecated"
  | "conflict"
  | "write-failed"
  | "candidate-invalid";

export interface ReviewProblem {
  code: ReviewProblemCode;
  message: string;
}

export interface ReviewPreflightRequest {
  bundleRoot: string;
  conceptId: string;
  reviewerId: string | null;
}

export interface ReviewPreflight {
  available: boolean;
  reasonCode: ReviewProblemCode | null;
  message: string;
  conceptId: string;
  relativePath: string;
  fingerprint: string;
  currentStatus: string | null;
  statusExplicit: boolean | null;
  reviewState: "unverified" | "machine-confirmed" | "human-reviewed" | null;
  reviewerHasReviewed: boolean;
  actionLabel: string | null;
  resultingStatus: "stable" | null;
  reviewedAt: string;
}

export interface ReviewConceptRequest {
  bundleRoot: string;
  conceptId: string;
  reviewerId: string;
  expectedFingerprint: string;
  reviewedAt: string;
}

export interface ReviewConceptResult {
  conceptId: string;
  relativePath: string;
  fingerprint: string;
  status: "stable";
  statusExplicit: true;
  actor: string;
  reviewedAt: string;
  verificationCount: number;
  message: string;
}

export function reviewProblem(error: unknown): ReviewProblem {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return error as ReviewProblem;
  }
  return {
    code: "write-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
