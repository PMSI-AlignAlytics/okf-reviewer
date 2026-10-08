// Read-only compatibility report. The MVP reports authored data as-is and does
// not stage, normalize, repair, export, or restore bundle files.

import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { useEffect, useState } from "react";
import { readCompatibilityReport } from "@/shared/ipc.ts";
import { useApp } from "@/shared/store.tsx";
import type {
  CompatibilityCategory,
  CompatibilityFinding,
  CompatibilityReport,
} from "@/shared/types.ts";
import "@/shared/styles/chrome.css";
import "@/shared/styles/baseui.css";
import "./ValidationPanel.css";

const CATEGORY_ORDER: CompatibilityCategory[] = ["parser", "link", "index", "extension"];
const CATEGORY_LABELS: Record<CompatibilityCategory, string> = {
  parser: "Parser",
  link: "Links",
  index: "Indexes",
  extension: "Extensions",
};

type ReportState =
  | { status: "idle" }
  | { status: "ready"; bundleRoot: string; report: CompatibilityReport }
  | { status: "error"; bundleRoot: string; message: string };

export function ValidationPanel() {
  const { state, actions } = useApp();
  const bundleRoot = state.activeRoot;
  const [reportState, setReportState] = useState<ReportState>({ status: "idle" });

  useEffect(() => {
    if (!state.panels.validation || !bundleRoot) return;
    let cancelled = false;
    void readCompatibilityReport(bundleRoot).then(
      (report) => {
        if (!cancelled) setReportState({ status: "ready", bundleRoot, report });
      },
      (error: unknown) => {
        if (!cancelled) {
          setReportState({
            status: "error",
            bundleRoot,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bundleRoot, state.panels.validation]);

  const current = reportState.status !== "idle" && reportState.bundleRoot === bundleRoot
    ? reportState
    : { status: "idle" as const };

  return (
    <Dialog.Root
      open={state.panels.validation}
      onOpenChange={(open) => actions.togglePanel("validation", open)}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="panel-backdrop" />
        <Dialog.Popup className="panel validation" aria-label="Compatibility report">
          <header className="panel-head">
            <div>
              <Dialog.Title render={<b />}>Compatibility report</Dialog.Title>
              <span>Read-only OKF conformance and portability findings</span>
            </div>
            <Dialog.Close className="btn ghost icon" aria-label="Close compatibility report">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <ScrollArea.Root className="validation-scroll">
            <ScrollArea.Viewport className="validation-scroll__viewport">
              <div className="validation-content">
                {current.status === "idle" && <p role="status">Loading compatibility report…</p>}
                {current.status === "error" && (
                  <p className="validation-error" role="alert">{current.message}</p>
                )}
                {current.status === "ready" && (
                  <CompatibilityFindings report={current.report} />
                )}
              </div>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar className="ui-scrollbar" orientation="vertical">
              <ScrollArea.Thumb className="ui-scrollbar-thumb" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CompatibilityFindings({ report }: { report: CompatibilityReport }) {
  if (report.findings.length === 0) {
    return (
      <div className="validation-empty" role="status">
        <CheckCircle2 size={20} aria-hidden="true" />
        <p>No compatibility findings.</p>
      </div>
    );
  }

  return (
    <>
      <p className="validation-boundary">
        Findings are advisory. OKF Reviewer never repairs authored files.
      </p>
      {CATEGORY_ORDER.map((category) => {
        const findings = report.findings.filter((finding) => finding.category === category);
        if (findings.length === 0) return null;
        return (
          <section key={category} className="validation-category">
            <h2>
              {CATEGORY_LABELS[category]}
              <span>{findings.length}</span>
            </h2>
            <ul>
              {findings.map((finding) => (
                <Finding key={findingKey(finding)} finding={finding} />
              ))}
            </ul>
          </section>
        );
      })}
      {report.truncated && (
        <p className="validation-truncated">
          <TriangleAlert size={14} aria-hidden="true" />
          The report was truncated by the backend limit.
        </p>
      )}
    </>
  );
}

function Finding({ finding }: { finding: CompatibilityFinding }) {
  const Icon = finding.level === "error" || finding.level === "warning"
    ? TriangleAlert
    : Info;
  return (
    <li className="validation-finding" data-level={finding.level}>
      <Icon size={15} aria-hidden="true" />
      <div>
        <header>
          <code>{finding.ruleId}</code>
          <span>{finding.level}</span>
        </header>
        <p>{finding.message}</p>
        <small>{finding.file}{finding.conceptId ? ` · ${finding.conceptId}` : ""}</small>
      </div>
    </li>
  );
}

function findingKey(finding: CompatibilityFinding): string {
  return `${finding.ruleId}:${finding.file}:${finding.conceptId ?? "bundle"}:${finding.message}`;
}
