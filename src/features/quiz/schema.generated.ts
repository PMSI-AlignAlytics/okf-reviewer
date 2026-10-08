// Generated from the application-owned okf-quiz-v1 JSON Schema.
// Run `node scripts/generate-quiz-types.mjs --write` after changing the schema.

export const QUIZ_SCHEMA_VERSION = 1 as const;
export const QUIZ_ARTIFACT_STATUSES = ["ready", "insufficient-evidence"] as const;
export const QUIZ_QUESTION_CATEGORIES = ["decision", "assumption", "constraint", "architecture", "behaviour", "failure-mode", "change", "fact"] as const;
export const QUIZ_CRITICALITIES = ["critical", "important", "supporting"] as const;

export const QUIZ_SCHEMA_LIMITS = {
  questions: 20,
  warnings: 10,
  choicesMinimum: 3,
  choicesMaximum: 5,
  evidencePerQuestion: 5,
  titleCharacters: 200,
  promptCharacters: 2000,
  choiceCharacters: 1000,
  explanationCharacters: 4000,
  evidenceQuoteCharacters: 2000,
} as const;

export type QuizArtifactStatus = (typeof QUIZ_ARTIFACT_STATUSES)[number];
export type QuizQuestionCategory = (typeof QUIZ_QUESTION_CATEGORIES)[number];
export type QuizCriticality = (typeof QUIZ_CRITICALITIES)[number];

export interface QuizChoice {
  id: string;
  text: string;
}

export interface QuizEvidenceReference {
  sourceId: string;
  heading: string;
  quote: string;
}

export interface QuizQuestion {
  id: string;
  category: QuizQuestionCategory;
  criticality: QuizCriticality;
  learningObjective: string;
  prompt: string;
  choices: QuizChoice[];
  correctChoiceId: string;
  explanation: string;
  evidence: QuizEvidenceReference[];
}

export interface QuizArtifact {
  schemaVersion: typeof QUIZ_SCHEMA_VERSION;
  requestId: string;
  bundleFingerprint: string;
  scopeFingerprint: string;
  status: QuizArtifactStatus;
  title: string;
  questions: QuizQuestion[];
  warnings: string[];
}
