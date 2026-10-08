#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(
  new URL(
    "../.codex/skills/okf-quiz/schemas/okf-quiz-v1.schema.json",
    import.meta.url,
  ),
);
const outputPath = fileURLToPath(
  new URL("../src/features/quiz/schema.generated.ts", import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const statuses = schema.properties.status.enum;
const categories = schema.$defs.question.properties.category.enum;
const criticalities = schema.$defs.question.properties.criticality.enum;
const question = schema.$defs.question.properties;

function quoted(values) {
  return values.map((value) => `"${value}"`).join(", ");
}

const definitionNames = new Map([
  ["#/$defs/choice", "QuizChoice"],
  ["#/$defs/evidence", "QuizEvidenceReference"],
  ["#/$defs/question", "QuizQuestion"],
]);

function schemaType(value) {
  if (value === schema.properties.schemaVersion) {
    return "typeof QUIZ_SCHEMA_VERSION";
  }
  if (value === schema.properties.status) {
    return "QuizArtifactStatus";
  }
  if (value === schema.$defs.question.properties.category) {
    return "QuizQuestionCategory";
  }
  if (value === schema.$defs.question.properties.criticality) {
    return "QuizCriticality";
  }
  if (value.$ref) {
    const referencedName = definitionNames.get(value.$ref);
    if (!referencedName) {
      throw new Error(`Unsupported quiz schema reference: ${value.$ref}`);
    }
    return referencedName;
  }
  if (Object.hasOwn(value, "const")) {
    return JSON.stringify(value.const);
  }
  if (value.enum) {
    return value.enum.map((entry) => JSON.stringify(entry)).join(" | ");
  }
  if (value.type === "string") {
    return "string";
  }
  if (value.type === "integer" || value.type === "number") {
    return "number";
  }
  if (value.type === "boolean") {
    return "boolean";
  }
  if (value.type === "array") {
    const itemType = schemaType(value.items);
    return itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`;
  }
  throw new Error(`Unsupported quiz schema shape: ${JSON.stringify(value)}`);
}

function renderInterface(name, value) {
  if (value.type !== "object" || value.additionalProperties !== false) {
    throw new Error(`${name} must be a closed object schema.`);
  }
  const required = new Set(value.required ?? []);
  const fields = Object.entries(value.properties).map(
    ([propertyName, propertySchema]) =>
      `  ${propertyName}${required.has(propertyName) ? "" : "?"}: ${schemaType(propertySchema)};`,
  );
  return `export interface ${name} {\n${fields.join("\n")}\n}`;
}

const generatedInterfaces = [
  renderInterface("QuizChoice", schema.$defs.choice),
  renderInterface("QuizEvidenceReference", schema.$defs.evidence),
  renderInterface("QuizQuestion", schema.$defs.question),
  renderInterface("QuizArtifact", schema),
].join("\n\n");

const output = `// Generated from the application-owned okf-quiz-v1 JSON Schema.
// Run \`node scripts/generate-quiz-types.mjs --write\` after changing the schema.

export const QUIZ_SCHEMA_VERSION = ${schema.properties.schemaVersion.const} as const;
export const QUIZ_ARTIFACT_STATUSES = [${quoted(statuses)}] as const;
export const QUIZ_QUESTION_CATEGORIES = [${quoted(categories)}] as const;
export const QUIZ_CRITICALITIES = [${quoted(criticalities)}] as const;

export const QUIZ_SCHEMA_LIMITS = {
  questions: ${schema.properties.questions.maxItems},
  warnings: ${schema.properties.warnings.maxItems},
  choicesMinimum: ${question.choices.minItems},
  choicesMaximum: ${question.choices.maxItems},
  evidencePerQuestion: ${question.evidence.maxItems},
  titleCharacters: ${schema.properties.title.maxLength},
  promptCharacters: ${question.prompt.maxLength},
  choiceCharacters: ${schema.$defs.choice.properties.text.maxLength},
  explanationCharacters: ${question.explanation.maxLength},
  evidenceQuoteCharacters: ${schema.$defs.evidence.properties.quote.maxLength},
} as const;

export type QuizArtifactStatus = (typeof QUIZ_ARTIFACT_STATUSES)[number];
export type QuizQuestionCategory = (typeof QUIZ_QUESTION_CATEGORIES)[number];
export type QuizCriticality = (typeof QUIZ_CRITICALITIES)[number];

${generatedInterfaces}
`;

if (process.argv.includes("--write")) {
  writeFileSync(outputPath, output, "utf8");
  console.log(`Wrote ${outputPath}`);
} else if (readFileSync(outputPath, "utf8") !== output) {
  console.error(
    "Generated quiz types are stale. Run: node scripts/generate-quiz-types.mjs --write",
  );
  process.exit(1);
} else {
  console.log("Quiz TypeScript types match the canonical JSON Schema.");
}
