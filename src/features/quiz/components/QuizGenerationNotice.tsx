import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { useApp } from "@/shared/store.tsx";
import "./QuizGenerationNotice.css";

export function QuizGenerationNotice() {
  const { state, actions } = useApp();
  const notice = state.quizNotification;
  if (!notice) return null;

  const Icon = notice.tone === "success"
    ? CheckCircle2
    : notice.tone === "error"
      ? CircleAlert
      : Info;

  return (
    <aside
      className={`quiz-generation-notice quiz-generation-notice--${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
      aria-live={notice.tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <Icon className="quiz-generation-notice__icon" size={20} aria-hidden="true" />
      <div className="quiz-generation-notice__body">
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
        {[notice.quizId, notice.failureId].some((id) => id !== null) && (
          <button
            type="button"
            className="btn primary quiz-generation-notice__action"
            onClick={() => void actions.openQuizNotification()}
          >
            Open quizzes
          </button>
        )}
      </div>
      <button
        type="button"
        className="btn ghost icon quiz-generation-notice__dismiss"
        aria-label="Dismiss quiz notification"
        onClick={() => actions.dismissQuizNotification()}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
