import { FileCheck2, History, LoaderCircle } from "lucide-react";
import { useApp } from "@/shared/store.tsx";
import "./StatusBar.css";

export function StatusBar() {
  const { state, actions } = useApp();
  if (!state.bundle && !state.quizGeneration) return <footer className="status-bar" />;

  return (
    <footer className="status-bar">
      {state.quizGeneration && (
        <div className="status-quiz-generation" role="status" aria-live="polite">
          <LoaderCircle
            className="status-quiz-generation__spinner"
            size={14}
            aria-hidden="true"
          />
          <span title={state.quizGeneration.message}>{state.quizGeneration.message}</span>
          <button type="button" onClick={() => actions.cancelQuizGeneration()}>Cancel</button>
        </div>
      )}
      {state.bundle && (
        <div className="status-region">
          <span className="status-item" aria-label={`${state.bundle.concepts.length} concepts`}>
            {state.bundle.concepts.length} concepts
          </span>
          <button
            type="button"
            className={`status-item status-toggle${state.panels.log ? " is-active" : ""}`}
            aria-label="Toggle bundle log"
            aria-pressed={state.panels.log}
            title="Bundle log (L)"
            onClick={() => actions.togglePanel("log")}
          >
            <span className="status-icon" aria-hidden="true">
              <History size={14} />
            </span>
            <span>Log</span>
          </button>
          <button
            type="button"
            className={`status-item status-toggle${state.panels.validation ? " is-active" : ""}`}
            aria-label="Toggle validation panel"
            aria-pressed={state.panels.validation}
            title="Bundle validation"
            onClick={() => actions.togglePanel("validation")}
          >
            <span className="status-icon" aria-hidden="true">
              <FileCheck2 size={14} />
            </span>
            <span>Validation</span>
          </button>
        </div>
      )}
    </footer>
  );
}
