import { CircleCheck, TriangleAlert } from "lucide-react";
import {
  formatInteropBytes,
  sidecarNeedsAttention,
} from "@/features/bundle/interop.ts";
import type {
  InteropReport,
  LanguageVariantGroup,
} from "@/features/bundle/interop.ts";
import "./ConceptExtensions.css";

export function ConceptLanguageSelect({
  conceptId,
  report,
  onSelect,
}: {
  conceptId: string;
  report: InteropReport;
  onSelect: (conceptId: string) => void;
}) {
  const group = languageGroupForConcept(report, conceptId);
  if (!group || group.variants.length < 2) return null;

  return (
    <label className="concept-language">
      <span>Language</span>
      <select
        aria-label="Concept language"
        value={conceptId}
        onChange={(event) => onSelect(event.target.value)}
      >
        {group.variants.map((variant) => (
          <option key={variant.conceptId} value={variant.conceptId}>
            {variant.language.toUpperCase()} · {variant.title}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ConceptResources({
  conceptId,
  report,
}: {
  conceptId: string;
  report: InteropReport;
}) {
  const resources = report.sidecars.filter((sidecar) => sidecar.conceptId === conceptId);
  if (resources.length === 0) return null;

  return (
    <section className="rail-module concept-resources">
      <h3 className="rail-title">
        Resources
        <span className="rail-count">{resources.length}</span>
      </h3>
      <ul>
        {resources.map((resource) => {
          const needsAttention = sidecarNeedsAttention(resource);
          return (
            <li key={resource.path}>
              <div className="concept-resource__head">
                <span aria-hidden="true" data-status={resource.status}>
                  {needsAttention
                    ? <TriangleAlert size={14} />
                    : <CircleCheck size={14} />}
                </span>
                <strong title={resource.path}>{resource.path}</strong>
              </div>
              <span>{resource.mediaType} · {formatInteropBytes(resource.size)}</span>
              <small>{resource.message}</small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function languageGroupForConcept(
  report: InteropReport,
  conceptId: string,
): LanguageVariantGroup | null {
  return report.multilingual.groups.find((group) =>
    group.variants.some((variant) => variant.conceptId === conceptId)) ?? null;
}
