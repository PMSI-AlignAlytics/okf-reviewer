import { Dialog } from "@base-ui/react/dialog";
import { Copy, ExternalLink, LoaderCircle, RefreshCw, Terminal, X } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/shared/store.tsx";
import "./QuizAuthenticationDialog.css";

const CODEX_AUTHENTICATION_URL = "https://developers.openai.com/codex/auth";

export function QuizAuthenticationDialog() {
  const { state, actions } = useApp();
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const generation = state.quizGeneration;
  const open = generation?.phase === "authentication-required"
    || generation?.phase === "checking-authentication"
    || generation?.phase === "signing-in";
  const checkingAuthentication = generation?.phase === "checking-authentication";
  const signingIn = generation?.phase === "signing-in";
  const isClaude = generation?.providerKind === "claude-cli";
  const providerName = isClaude ? "Claude Code" : "Codex";
  const guidance = generation?.authenticationGuidance ?? null;
  const commands = guidance
    ? [
        { id: "login", label: "Sign in", command: guidance.loginCommand },
        ...(guidance.deviceCodeLoginCommand
          ? [{
              id: "device-code",
              label: "Device-code fallback",
              command: guidance.deviceCodeLoginCommand,
            }]
          : []),
        { id: "status", label: "Check status", command: guidance.statusCommand },
      ]
    : [];

  async function copyCommand(id: string, command: string) {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) return;
    await clipboard.writeText(command);
    setCopiedCommand(id);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) actions.cancelQuizGeneration();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className="ui-dialog quiz-auth-dialog">
          <header className="quiz-auth-dialog__header">
            <div>
              <Dialog.Title className="ui-dialog-title">
                {isClaude
                  ? signingIn ? "Sign in to Claude Code" : "Claude Code sign-in required"
                  : checkingAuthentication
                    ? "Checking Codex CLI sign-in"
                    : "Codex CLI sign-in required"}
              </Dialog.Title>
              <Dialog.Description className="quiz-auth-dialog__description">
                {isClaude
                  ? signingIn
                    ? "Finish sign-in in the command window opened by OKF Reviewer."
                    : "Open Claude Code's guided sign-in window to continue generating this quiz."
                  : "Sign in from a terminal using the CLI below, then return here and check again."}
              </Dialog.Description>
            </div>
            <button
              type="button"
              className="btn ghost icon"
              aria-label={`Cancel ${providerName} sign-in`}
              onClick={() => actions.cancelQuizGeneration()}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          {generation?.message ? (
            <p className="quiz-auth-dialog__status" role="status">
              {checkingAuthentication || signingIn ? (
                <LoaderCircle
                  className="quiz-auth-dialog__spinner"
                  size={17}
                  aria-hidden="true"
                />
              ) : null}
              <span>{generation.message}</span>
            </p>
          ) : null}

          {!isClaude ? (
            <>
              <dl className="quiz-auth-dialog__runtime">
                <div>
                  <dt>Resolved CLI</dt>
                  <dd>
                    <code>
                      {guidance?.resolvedDisplayPath
                        ?? generation?.providerExecutable
                        ?? "Codex CLI"}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{generation?.providerVersion ?? "Unknown"}</dd>
                </div>
              </dl>

              {commands.length > 0 ? (
                <div className="quiz-auth-dialog__commands" aria-label="Codex CLI commands">
                  {commands.map(({ id, label, command }) => (
                    <div className="quiz-auth-dialog__command" key={id}>
                      <span>{label}</span>
                      <code>{command}</code>
                      <button
                        type="button"
                        className="btn ghost icon"
                        aria-label={`Copy ${label.toLowerCase()} command`}
                        onClick={() => void copyCommand(id, command)}
                      >
                        <Copy size={15} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  <span className="sr-only" aria-live="polite">
                    {copiedCommand ? "Command copied." : ""}
                  </span>
                </div>
              ) : null}

              <p className="quiz-auth-dialog__guidance">
                Normal sign-in uses <code>codex login</code>. Device-code sign-in is a beta
                fallback and may need to be enabled in your ChatGPT security or workspace
                settings.
              </p>
            </>
          ) : null}

          <p className="quiz-auth-dialog__privacy">
            Credentials are handled by the {providerName} CLI. OKF Reviewer does not ask for
            or store your password; the CLI reuses its normal local sign-in session on later
            runs.
          </p>

          <footer className="quiz-auth-dialog__actions">
            <button
              type="button"
              className="btn"
              onClick={() => actions.cancelQuizGeneration()}
            >
              Cancel
            </button>
            {isClaude && !signingIn ? (
              <button
                type="button"
                className="btn primary"
                onClick={() => actions.chooseQuizAuthentication("terminal")}
              >
                <Terminal size={16} aria-hidden="true" />
                Open sign-in window
              </button>
            ) : null}
            {!isClaude ? (
              <button
                type="button"
                className="btn"
                onClick={() => actions.openExternal(CODEX_AUTHENTICATION_URL)}
              >
                <ExternalLink size={16} aria-hidden="true" />
                Open official instructions
              </button>
            ) : null}
            {!isClaude ? (
              <button
                type="button"
                className="btn primary"
                disabled={checkingAuthentication}
                aria-busy={checkingAuthentication}
                onClick={() => actions.recheckQuizAuthentication()}
              >
                {checkingAuthentication
                  ? <LoaderCircle className="quiz-auth-dialog__spinner" size={16} aria-hidden="true" />
                  : <RefreshCw size={16} aria-hidden="true" />}
                {checkingAuthentication ? "Checking…" : "Check again"}
              </button>
            ) : null}
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
