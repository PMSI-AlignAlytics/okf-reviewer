import { CircleAlert, ExternalLink, ShieldCheck } from "lucide-react";
import type {
  ConceptEvidence,
  EvidenceSource,
} from "@/shared/evidence.ts";
import "./EvidencePanel.css";

interface EvidencePanelProps {
  evidence: ConceptEvidence;
  onOpenExternal: (url: string) => void;
}

export function EvidencePanel({
  evidence,
  onOpenExternal,
}: EvidencePanelProps) {
  if (evidence.sources.length === 0 && evidence.diagnostics.length === 0) {
    return null;
  }

  return (
    <section className="rail-module evidence-panel" aria-labelledby="evidence-panel-title">
      <h3 className="rail-title" id="evidence-panel-title">
        Evidence
        {evidence.sources.length > 0 && (
          <span className="rail-count">{evidence.sources.length}</span>
        )}
      </h3>
      <p className="evidence-panel__boundary">
        <ShieldCheck size={14} aria-hidden="true" />
        Authored evidence, not a truth verdict. OKF Reviewer does not refresh sources.
      </p>
      {evidence.sources.length > 0 && (
        <ul className="evidence-panel__sources">
          {evidence.sources.map((source) => (
            <EvidenceSourceRow
              key={source.id}
              source={source}
              onOpen={() => source.uri && onOpenExternal(source.uri)}
            />
          ))}
        </ul>
      )}
      {evidence.diagnostics.length > 0 && (
        <ul className="evidence-panel__diagnostics" aria-label="Evidence advice">
          {evidence.diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.kind}:${diagnostic.sourceId}:${diagnostic.line ?? "none"}:${index}`}>
              <CircleAlert size={13} aria-hidden="true" />
              <span>
                {diagnostic.message}
                {diagnostic.line ? ` Body line ${diagnostic.line}.` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EvidenceSourceRow({
  source,
  onOpen,
}: {
  source: EvidenceSource;
  onOpen: () => void;
}) {
  return (
    <li>
      <header>
        <strong>{source.title}</strong>
        <span
          className="evidence-panel__status"
          data-status={source.lastStatus}
          role="status"
        >
          {statusLabel(source.lastStatus)}
        </span>
      </header>
      {source.locator && <p title={source.locator}>{source.locator}</p>}
      <dl>
        {source.observedAt && (
          <div>
            <dt>Observed</dt>
            <dd>
              <time dateTime={source.observedAt} title={source.observedAt}>
                {source.observedAt.slice(0, 10)}
              </time>
            </dd>
          </div>
        )}
        {source.lastCheckedAt && (
          <div>
            <dt>Last checked</dt>
            <dd>
              <time dateTime={source.lastCheckedAt} title={source.lastCheckedAt}>
                {source.lastCheckedAt.slice(0, 10)}
              </time>
            </dd>
          </div>
        )}
        {source.adapterId && (
          <div>
            <dt>Adapter</dt>
            <dd>{source.adapterId}{source.adapterVersion === null ? "" : ` v${source.adapterVersion}`}</dd>
          </div>
        )}
        {source.sourceDigest && (
          <div>
            <dt>Digest</dt>
            <dd><code title={source.sourceDigest}>{source.sourceDigest.slice(-10)}</code></dd>
          </div>
        )}
      </dl>
      {source.uri && (
        <div className="evidence-panel__actions">
          <button type="button" onClick={onOpen}>
            <ExternalLink size={13} aria-hidden="true" />
            Open
          </button>
        </div>
      )}
    </li>
  );
}

function statusLabel(status: EvidenceSource["lastStatus"]): string {
  const labels = {
    unchecked: "Not checked",
    available: "Available",
    changed: "Changed",
    unavailable: "Unavailable",
  };
  return labels[status];
}
