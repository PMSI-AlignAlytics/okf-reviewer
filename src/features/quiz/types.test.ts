import {
  QUIZ_ARTIFACT_STATUSES,
  QUIZ_CRITICALITIES,
  QUIZ_QUESTION_CATEGORIES,
  QUIZ_SCHEMA_LIMITS,
  QUIZ_SCHEMA_VERSION,
} from "@/features/quiz/schema.generated.ts";
import {
  readQuizCapabilityRegistration,
  validateQuizArtifact,
} from "@/shared/ipc.ts";

describe("quiz foundation contracts", () => {
  it("exposes the canonical schema vocabulary and bounds", () => {
    expect(QUIZ_SCHEMA_VERSION).toBe(1);
    expect(QUIZ_ARTIFACT_STATUSES).toEqual(["ready", "insufficient-evidence"]);
    expect(QUIZ_QUESTION_CATEGORIES).toEqual([
      "decision",
      "assumption",
      "constraint",
      "architecture",
      "behaviour",
      "failure-mode",
      "change",
      "fact",
    ]);
    expect(QUIZ_CRITICALITIES).toEqual(["critical", "important", "supporting"]);
    expect(QUIZ_SCHEMA_LIMITS).toMatchObject({
      questions: 20,
      choicesMinimum: 3,
      choicesMaximum: 5,
      promptCharacters: 2000,
      explanationCharacters: 4000,
    });
  });

  it("registers a provider-neutral task with no model tools or mutation authority", async () => {
    const registration = await readQuizCapabilityRegistration();
    expect(registration.task).toMatchObject({
      id: "okf-quiz",
      readOnly: true,
      providerIndependent: true,
      usesFrozenEvidencePacket: true,
      allowsBundleChanges: false,
      allowsSettingsMutation: false,
      allowedTools: ["repository-read", "git-read"],
      networkPolicy: "provider-transport-only",
    });
  });

  it("does not substitute frontend validation for the trusted backend", async () => {
    await expect(
      validateQuizArtifact({
        request: {
          requestId: "request-1",
          bundleFingerprint: "bundle-1",
          scopeFingerprint: "scope-1",
          scopeMode: "current-document",
          questionCountPolicy: "exact",
          requestedQuestionCount: 1,
          requestedDifficulty: "foundational",
          evidenceSources: [],
          scopeSourceIds: [],
          topic: null,
          baseRevisionId: null,
          headRevisionId: null,
        },
        currentState: {
          bundleFingerprint: "bundle-1",
          scopeFingerprint: "scope-1",
          sources: [],
        },
        rawOutput: null,
      }),
    ).rejects.toThrow("trusted native validation");
  });
});
