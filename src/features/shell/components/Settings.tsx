import {
  BookOpenText,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Palette,
  Settings2,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { Checkbox } from "@base-ui/react/checkbox";
import { NumberField } from "@base-ui/react/number-field";
import { useApp } from "@/shared/store.tsx";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import type { Settings as SettingsModel, ThemeMode } from "@/shared/types.ts";
import { ZOOM_EVENT } from "@/shared/platform/native.ts";
import { interfaceScale, UI_SCALE_OPTIONS } from "@/shared/uiScale.ts";
import { modKey } from "@/shared/platform/platform.ts";
import type { ZoomIntent } from "@/shared/platform/native.ts";
import * as ipc from "@/shared/ipc.ts";
import type {
  CliGeneratorSettings,
  CodexReasoningEffort,
  QuizGeneratorSettings,
} from "@/features/quiz/types.ts";
import {
  SettingRow,
  SettingsEmptyState,
  SettingsGroup,
  SettingsWorkspace,
} from "./SettingsWorkspace.tsx";
import type {
  SettingsNavigationItem,
  SettingsSectionId,
} from "./SettingsWorkspace.tsx";
import "@/shared/styles/chrome.css";
import "@/shared/styles/baseui.css";
import "./Settings.css";
import { AppUpdatesSettings } from "@/features/updates/AppUpdates.tsx";

const THEME_LABELS: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const READER_SCALE_MIN = 0.8;
const READER_SCALE_MAX = 1.6;
const READER_SCALE_STEP = 0.1;
const SCALE_OPTIONS = [0.9, 1, 1.15, 1.3] as const;
const SCALE_LABELS: Record<string, string> = {
  "0.9": "Small",
  "1": "Default",
  "1.15": "Large",
  "1.3": "Larger",
};

const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    description: "Manage application updates and local bundle discovery.",
    icon: Settings2,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Choose the interface theme and motion behavior.",
    icon: Palette,
  },
  {
    id: "reading",
    label: "Reading",
    description: "Tune the concept reader without scaling the rest of the app.",
    icon: BookOpenText,
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description: "Set the local human identity used for explicit concept reviews.",
    icon: UserRound,
  },
  {
    id: "generators",
    label: "Quiz generators",
    description: "Configure and test local CLI and model API generators.",
    icon: BrainCircuit,
  },
] as const satisfies readonly SettingsNavigationItem[];

interface SettingsSearchItem {
  id: string;
  section: SettingsSectionId;
  title: string;
  description: string;
  keywords: string;
}

const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "app-updates",
    section: "general",
    title: "Application updates",
    description: "Check for a new release and update OKF Reviewer.",
    keywords: "version update upgrade release download install restart about",
  },
  {
    id: "scan-depth",
    section: "general",
    title: "Bundle scan depth",
    description: "Set how far bundle discovery descends into subfolders.",
    keywords: "autodetect discovery folder nesting max depth",
  },
  {
    id: "theme",
    section: "appearance",
    title: "Theme",
    description: "Follow the operating system or choose a light or dark interface.",
    keywords: "system light dark color appearance",
  },
  {
    id: "reduce-motion",
    section: "appearance",
    title: "Reduce motion",
    description: "Limit interface transitions and animated movement.",
    keywords: "accessibility animation transition motion",
  },
  {
    id: "interface-size",
    section: "appearance",
    title: "Interface size",
    description: "Enlarge navigation, controls, dialogs, and quizzes.",
    keywords: "accessibility magnification zoom scale font low vision",
  },
  {
    id: "keyboard-shortcuts",
    section: "general",
    title: "Keyboard shortcuts",
    description: "Find shortcuts for browsing, searching, tabs, and reading.",
    keywords: "help keys keyboard commands shortcuts",
  },
  {
    id: "reader-size",
    section: "reading",
    title: "Reader text size",
    description: "Scale concept prose without changing the app chrome.",
    keywords: "font zoom text scale concept reader",
  },
  {
    id: "reviewer-id",
    section: "reviewer",
    title: "Reviewer ID",
    description: "Set the stable identifier appended to OKF verification history.",
    keywords: "human identity actor verification review",
  },
  {
    id: "reviewer-name",
    section: "reviewer",
    title: "Reviewer name",
    description: "Keep an optional display name in local app settings.",
    keywords: "human identity local display name",
  },
  {
    id: "reviewer-email",
    section: "reviewer",
    title: "Reviewer email",
    description: "Keep an optional email in local app settings.",
    keywords: "human identity local email",
  },
  {
    id: "quiz-generators",
    section: "generators",
    title: "Quiz generators",
    description: "Configure Codex CLI, Claude Code CLI, and model API profiles.",
    keywords: "quiz codex claude cli model api provider test setup",
  },
];

function clampScale(value: number): number {
  return Math.min(READER_SCALE_MAX, Math.max(READER_SCALE_MIN, value));
}

function roundScale(value: number): number {
  return Math.round(value * 10) / 10;
}

function scaleLabel(value: number): string {
  return SCALE_LABELS[String(value)] ?? `${Math.round(value * 100)}%`;
}

function sectionLabel(sectionId: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === sectionId)?.label ?? sectionId;
}

function SettingsToggle({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox.Root
      className="settings-toggle"
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
    >
      <span className="settings-toggle__thumb" aria-hidden="true" />
    </Checkbox.Root>
  );
}

function ThemeSelect({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={(next) => { if (next) onChange(next); }}>
      <Select.Trigger className="ui-select-trigger" aria-label="Theme">
        <Select.Value>
          {(selected) => THEME_LABELS[(selected as ThemeMode | null) ?? "system"]}
        </Select.Value>
        <Select.Icon className="ui-select-icon" aria-hidden="true">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={4}>
          <Select.Popup className="ui-select-popup">
            {(Object.keys(THEME_LABELS) as ThemeMode[]).map((mode) => (
              <Select.Item key={mode} value={mode} className="ui-select-item">
                <Select.ItemText>{THEME_LABELS[mode]}</Select.ItemText>
                <Select.ItemIndicator className="ui-select-check">
                  <Check size={13} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function ReaderScaleSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(roundScale(Number(next)))}>
      <Select.Trigger className="ui-select-trigger" aria-label="Reader text size">
        <Select.Value>
          {(selected) => scaleLabel((selected as number | null) ?? 1)}
        </Select.Value>
        <Select.Icon className="ui-select-icon" aria-hidden="true">
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={4}>
          <Select.Popup className="ui-select-popup">
            {SCALE_OPTIONS.map((scale) => (
              <Select.Item key={scale} value={scale} className="ui-select-item">
                <Select.ItemText>{scaleLabel(scale)}</Select.ItemText>
                <Select.ItemIndicator className="ui-select-check">
                  <Check size={13} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function GeneralSettings({
  settings,
  onUpdate,
}: {
  settings: SettingsModel;
  onUpdate: (patch: Partial<SettingsModel>) => void;
}) {
  return (
    <>
    <AppUpdatesSettings />
    <SettingsGroup
      title="Bundle discovery"
      description="Discovery stays bounded to the folder you opened and skips generated directories."
    >
      <SettingRow
        id="setting-scan-depth"
        title="Bundle scan depth"
        description="How many folder levels discovery examines below the folder you opened."
        control={(
          <NumberField.Root
            value={settings.scanMaxDepth}
            min={1}
            max={64}
            onValueChange={(value) => {
              if (value != null) onUpdate({ scanMaxDepth: Math.floor(value) });
            }}
          >
            <NumberField.Group className="ui-numberfield-group">
              <NumberField.Decrement className="ui-numberfield-btn" aria-label="Decrease scan depth">
                &minus;
              </NumberField.Decrement>
              <NumberField.Input className="ui-numberfield-input" aria-label="Bundle scan depth" />
              <NumberField.Increment className="ui-numberfield-btn" aria-label="Increase scan depth">
                +
              </NumberField.Increment>
            </NumberField.Group>
          </NumberField.Root>
        )}
      />
    </SettingsGroup>
    <SettingsGroup title="Keyboard shortcuts" description="Use these shortcuts throughout the workspace. Search returns to the reader and keeps unfinished quizzes available.">
      <div id="setting-keyboard-shortcuts" className="settings-shortcuts" tabIndex={-1}>
        {[
          ["Open folder", `${modKey} O`],
          ["Switch bundle", `${modKey} P`],
          ["Search concepts", `${modKey} K or /`],
          ["Settings", `${modKey} ,`],
          ["New reader tab", `${modKey} T`],
          ["Close reader tab", `${modKey} W`],
          ["Cycle reader tabs", "Ctrl Tab / Ctrl Shift Tab"],
          ["Navigation history", "Alt ← / Alt →"],
          ["Toggle navigation", "["],
          ["Refresh bundle", "R"],
          ["Bundle log", "L"],
          ["Reader text size", `${modKey} + / − / 0`],
          ["Speed read", "S"],
        ].map(([action, keys]) => (
          <div key={action}><span>{action}</span><kbd>{keys}</kbd></div>
        ))}
      </div>
    </SettingsGroup>
    </>
  );
}

function AppearanceSettings({
  settings,
  onUpdate,
}: {
  settings: SettingsModel;
  onUpdate: (patch: Partial<SettingsModel>) => void;
}) {
  return (
    <SettingsGroup
      title="Interface"
      description="Appearance follows the operating system by default and stays local to OKF Reviewer."
    >
      <SettingRow
        id="setting-theme"
        title="Theme"
        description="Follow the operating system or keep the interface light or dark."
        control={<ThemeSelect value={settings.theme} onChange={(theme) => onUpdate({ theme })} />}
      />
      <SettingRow
        id="setting-interface-size"
        title="Interface size"
        description="Enlarge the entire app. Reader text size remains independently adjustable."
        control={(
          <Select.Root value={interfaceScale(settings.uiScale)} onValueChange={(value) => {
            if (value !== null) onUpdate({ uiScale: interfaceScale(value) });
          }}>
            <Select.Trigger className="ui-select-trigger" aria-label="Interface size">
              <Select.Value>{(value) => `${Math.round(Number(value ?? 1) * 100)}%`}</Select.Value>
              <Select.Icon className="ui-select-icon" aria-hidden="true"><ChevronDown size={14} /></Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner className="ui-select-positioner" sideOffset={4}>
                <Select.Popup className="ui-select-popup">
                  {UI_SCALE_OPTIONS.map((scale) => (
                    <Select.Item key={scale} value={scale} className="ui-select-item">
                      <Select.ItemText>{Math.round(scale * 100)}%</Select.ItemText>
                      <Select.ItemIndicator className="ui-select-check"><Check size={13} /></Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        )}
      />
      <SettingRow
        id="setting-reduce-motion"
        title="Reduce motion"
        description="Limit transitions and animated movement throughout the interface."
        control={(
          <SettingsToggle
            label="Reduce motion"
            checked={settings.reduceMotion}
            onCheckedChange={(reduceMotion) => onUpdate({ reduceMotion })}
          />
        )}
      />
    </SettingsGroup>
  );
}

function ReadingSettings({
  settings,
  onUpdate,
}: {
  settings: SettingsModel;
  onUpdate: (patch: Partial<SettingsModel>) => void;
}) {
  return (
    <SettingsGroup
      title="Concept reader"
      description="Reading preferences affect concept prose without resizing the application chrome."
    >
      <SettingRow
        id="setting-reader-size"
        title="Reader text size"
        description="Ctrl/Cmd +, -, and 0 adjust the same setting."
        control={(
          <ReaderScaleSelect
            value={settings.readerScale}
            onChange={(readerScale) => onUpdate({ readerScale })}
          />
        )}
      />
    </SettingsGroup>
  );
}

function ReviewerSettings({
  settings,
  onUpdate,
}: {
  settings: SettingsModel;
  onUpdate: (patch: Partial<SettingsModel>) => void;
}) {
  return (
    <SettingsGroup
      title="Human reviewer"
      description="The ID is written to OKF as human:<id>. Name and email stay in local settings."
    >
      <SettingRow
        id="setting-reviewer-id"
        title="Reviewer ID"
        description="Required before a review can be confirmed. Use a durable handle."
        control={(
          <label className="settings-reviewer-id">
            <span aria-hidden="true">human:</span>
            <input
              aria-label="Reviewer ID"
              maxLength={128}
              pattern="[A-Za-z0-9._@-]*"
              value={settings.reviewerId}
              onChange={(event) => {
                onUpdate({ reviewerId: event.target.value.replace(/^human:/u, "") });
              }}
              autoComplete="username"
            />
          </label>
        )}
      />
      <SettingRow
        id="setting-reviewer-name"
        title="Name"
        description="Optional local display name. It is not written into the concept."
        control={(
          <input
            className="settings-text-input"
            aria-label="Reviewer name"
            value={settings.reviewerName}
            onChange={(event) => onUpdate({ reviewerName: event.target.value })}
            autoComplete="name"
          />
        )}
      />
      <SettingRow
        id="setting-reviewer-email"
        title="Email"
        description="Optional local contact metadata. It is not written into the concept."
        control={(
          <input
            className="settings-text-input"
            aria-label="Reviewer email"
            type="email"
            value={settings.reviewerEmail}
            onChange={(event) => onUpdate({ reviewerEmail: event.target.value })}
            autoComplete="email"
          />
        )}
      />
    </SettingsGroup>
  );
}

function QuizGeneratorSettingsPanel() {
  const [config, setConfig] = useState<QuizGeneratorSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTest, setActiveTest] = useState<{
    kind: "codex-cli" | "claude-cli";
    live: boolean;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [apiLabel, setApiLabel] = useState("");
  const [apiEndpoint, setApiEndpoint] = useState("");
  const [apiModel, setApiModel] = useState("");
  const [apiKey, setApiKey] = useState("");

  async function reload() {
    setConfig(await ipc.quizGeneratorSettings());
  }

  useEffect(() => {
    void ipc.quizGeneratorSettings()
      .then(setConfig)
      .catch((problem: unknown) => setMessage(String(problem)));
  }, []);

  function updateCli(
    kind: "codex-cli" | "claude-cli",
    patch: Partial<CliGeneratorSettings>,
  ) {
    setConfig((current) => {
      if (!current) return current;
      const key = kind === "codex-cli" ? "codexCli" : "claudeCli";
      const next = { ...current, [key]: { ...current[key], ...patch } };
      if (patch.enabled === false && next.defaultProfileId === kind) {
        next.defaultProfileId = kind === "codex-cli" && next.claudeCli.enabled
          ? "claude-cli"
          : kind === "claude-cli" && next.codexCli.enabled
            ? "codex-cli"
            : next.apiProfiles[0]?.id ?? null;
      }
      return next;
    });
  }

  async function saveConfiguration(): Promise<QuizGeneratorSettings> {
    if (!config) throw new Error("Generator settings are still loading.");
    const codexPath = config.codexCli.executablePath?.trim();
    const codexModel = config.codexCli.model?.trim();
    const claudePath = config.claudeCli.executablePath?.trim();
    const claudeModel = config.claudeCli.model?.trim();
    const saved = await ipc.saveQuizGeneratorSettings({
      expectedRevision: config.revision,
      defaultProfileId: config.defaultProfileId,
      codexCli: {
        ...config.codexCli,
        executablePath: codexPath?.length ? codexPath : null,
        model: codexModel?.length ? codexModel : null,
      },
      claudeCli: {
        ...config.claudeCli,
        executablePath: claudePath?.length ? claudePath : null,
        model: claudeModel?.length ? claudeModel : null,
      },
    });
    setConfig(saved);
    return saved;
  }

  async function testCli(kind: "codex-cli" | "claude-cli", live: boolean) {
    setBusy(true);
    setActiveTest({ kind, live });
    setMessage(live ? "Running the live structured-output test..." : "Checking local CLI setup...");
    try {
      const saved = await saveConfiguration();
      const model = kind === "codex-cli" ? saved.codexCli.model : saved.claudeCli.model;
      const result = live
        ? await ipc.quizProviderLiveTest(kind, model)
        : await ipc.quizProviderPreflight(kind, model);
      setMessage(result.message);
      await reload();
    } catch (problem) {
      setMessage(String(problem));
    }
    setActiveTest(null);
    setBusy(false);
  }

  async function addApiProfile() {
    setBusy(true);
    setMessage(null);
    try {
      await ipc.saveQuizApiProfile({
        id: null,
        label: apiLabel,
        endpoint: apiEndpoint,
        model: apiModel,
        apiKey: apiKey.length > 0 ? apiKey : null,
      });
      setApiLabel("");
      setApiEndpoint("");
      setApiModel("");
      setApiKey("");
      await reload();
      setMessage("Model API profile saved.");
    } catch (problem) {
      setMessage(String(problem));
    }
    setBusy(false);
  }

  async function deleteApiProfile(profileId: string) {
    setBusy(true);
    setMessage(null);
    try {
      await ipc.deleteQuizApiProfile(profileId);
      await reload();
      setMessage("Model API profile deleted.");
    } catch (problem) {
      setMessage(String(problem));
    }
    setBusy(false);
  }

  if (!config) {
    return <p role="status">Loading quiz generator settings…</p>;
  }

  const availableProfiles = [
    ...(config.codexCli.enabled ? [{ id: "codex-cli", label: "Codex CLI" }] : []),
    ...(config.claudeCli.enabled ? [{ id: "claude-cli", label: "Claude Code CLI" }] : []),
    ...config.apiProfiles.map((profile) => ({ id: profile.id, label: profile.label })),
  ];

  const renderCli = (
    kind: "codex-cli" | "claude-cli",
    title: string,
    value: CliGeneratorSettings,
  ) => (
    <div className="settings-generator" key={kind}>
      <div className="settings-generator__heading">
        <div><h4>{title}</h4><p>Authentication remains managed by the CLI.</p></div>
        <SettingsToggle
          label={`Enable ${title}`}
          checked={value.enabled}
          onCheckedChange={(enabled) => updateCli(kind, { enabled })}
        />
      </div>
      <label>
        Executable path <span>(optional; leave blank for automatic discovery)</span>
        <input
          className="settings-text-input settings-generator__input"
          value={value.executablePath ?? ""}
          onChange={(event) => updateCli(kind, {
            executablePath: event.target.value.length > 0 ? event.target.value : null,
          })}
          disabled={!value.enabled}
        />
      </label>
      <label>
        Model <span>(optional)</span>
        <input
          className="settings-text-input settings-generator__input"
          value={value.model ?? ""}
          onChange={(event) => updateCli(kind, {
            model: event.target.value.length > 0 ? event.target.value : null,
          })}
          disabled={!value.enabled}
        />
      </label>
      {kind === "codex-cli" && (
        <label>
          Reasoning effort <span>(applied to live tests and quiz generation)</span>
          <select
            className="settings-text-input settings-generator__input"
            value={value.reasoningEffort ?? "high"}
            onChange={(event) => updateCli(kind, {
              reasoningEffort: event.target.value as CodexReasoningEffort,
            })}
            disabled={!value.enabled}
          >
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
        </label>
      )}
      {value.lastDiagnostic && (
        <p className={value.lastDiagnostic.available ? "settings-generator__status" : "settings-generator__status settings-generator__status--error"}>
          {value.lastDiagnostic.message}
          {value.lastDiagnostic.version ? ` Version: ${value.lastDiagnostic.version}.` : ""}
          {value.lastDiagnostic.executable ? ` Resolved executable: ${value.lastDiagnostic.executable}.` : ""}
        </p>
      )}
      <div className="settings-generator__actions">
        <button type="button" disabled={busy || !value.enabled} onClick={() => void testCli(kind, false)}>
          {activeTest?.kind === kind && !activeTest.live ? "Checking setup..." : "Check setup"}
        </button>
        <button type="button" disabled={busy || !value.enabled} onClick={() => void testCli(kind, true)}>
          {activeTest?.kind === kind && activeTest.live ? "Running live test..." : "Run live test"}
        </button>
        <span>
          {kind === "codex-cli"
            ? "If signed out, setup opens Codex browser login automatically. Live tests may consume provider credits and never include bundle content."
            : "Live tests may consume provider credits and never include bundle content."}
        </span>
      </div>
    </div>
  );

  return (
    <div id="setting-quiz-generators" tabIndex={-1} className="settings-anchor">
      <SettingsGroup
        title="Quiz generators"
        description="User-level generator configuration is stored outside the installation and persists across app updates or reinstalls."
      >
        <SettingRow
          title="Default generator"
          description="Used for new and quick quizzes. Quick quiz sends the frozen target and selected bundle context to this generator."
          control={(
            <select
              className="settings-text-input"
              value={config.defaultProfileId ?? ""}
              onChange={(event) => setConfig({
                ...config,
                defaultProfileId: event.target.value.length > 0 ? event.target.value : null,
              })}
            >
              <option value="">No default</option>
              {availableProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            </select>
          )}
        />
        {renderCli("codex-cli", "Codex CLI", config.codexCli)}
        {renderCli("claude-cli", "Claude Code CLI", config.claudeCli)}
        <div className="settings-generator__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveConfiguration()
              .then(() => setMessage("Generator settings saved."))
              .catch((problem: unknown) => setMessage(String(problem)))}
          >
            Save generator settings
          </button>
        </div>
        {message && <p role="status" className="settings-generator__message">{message}</p>}
      </SettingsGroup>

      <SettingsGroup
        title="Model API profiles"
        description="API keys are stored in the operating-system credential service and are never returned to the interface."
      >
        {config.apiProfiles.map((profile) => (
          <SettingRow
            key={profile.id}
            title={profile.label}
            description={`${profile.model ?? "No model"} · ${profile.endpoint ?? "No endpoint"}`}
            control={<button type="button" disabled={busy} onClick={() => void deleteApiProfile(profile.id)}>Delete</button>}
          />
        ))}
        <div className="settings-generator settings-generator--api">
          <label>Profile name<input className="settings-text-input" value={apiLabel} onChange={(event) => setApiLabel(event.target.value)} /></label>
          <label>OpenAI-compatible endpoint<input className="settings-text-input" value={apiEndpoint} onChange={(event) => setApiEndpoint(event.target.value)} placeholder="https://…/v1/chat/completions" /></label>
          <label>Model<input className="settings-text-input" value={apiModel} onChange={(event) => setApiModel(event.target.value)} /></label>
          <label>API key<input className="settings-text-input" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
          <div className="settings-generator__actions">
            <button type="button" disabled={busy} onClick={() => void addApiProfile()}>Add model API profile</button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}

function SettingsSearchResults({
  results,
  onSelect,
}: {
  results: readonly SettingsSearchItem[];
  onSelect: (item: SettingsSearchItem) => void;
}) {
  if (results.length === 0) {
    return (
      <SettingsEmptyState
        title="No settings found"
        description="Try a broader term such as theme, reader, reviewer, or discovery."
      />
    );
  }

  return (
    <ul className="settings-search-results">
      {results.map((item) => (
        <li key={item.id}>
          <button type="button" className="settings-search-result" onClick={() => onSelect(item)}>
            <span>
              <small>{sectionLabel(item.section)}</small>
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface SettingsProps {
  initialSection?: SettingsSectionId;
  initialQuery?: string;
}

export function Settings({
  initialSection = "general",
  initialQuery = "",
}: SettingsProps = {}) {
  const { state, actions } = useApp();
  const settings = state.settings;
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [query, setQuery] = useState(initialQuery);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    const openSection = (event: Event) => {
      const section = (event as CustomEvent<SettingsSectionId>).detail;
      if (SETTINGS_SECTIONS.some((candidate) => candidate.id === section)) {
        setActiveSection(section);
        setQuery("");
      }
    };
    window.addEventListener("okf-review:open-settings-section", openSection);
    return () => window.removeEventListener("okf-review:open-settings-section", openSection);
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchResults = normalizedQuery.length === 0
    ? []
    : SETTINGS_SEARCH_ITEMS.filter((item) => {
        const category = sectionLabel(item.section);
        return `${item.title} ${item.description} ${item.keywords} ${category}`
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      });

  useEffect(() => {
    const onZoom = (event: Event): void => {
      const intent = (event as CustomEvent<ZoomIntent>).detail;
      if (intent === 0) {
        actions.updateSettings({ readerScale: 1 });
        return;
      }
      const next = clampScale(settings.readerScale + intent * READER_SCALE_STEP);
      actions.updateSettings({ readerScale: roundScale(next) });
    };
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, [settings.readerScale, actions]);

  useEffect(() => {
    if (!focusTarget || query.length > 0) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`setting-${focusTarget}`)
        ?? document.getElementById("settings-content-title");
      target?.focus();
      setFocusTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, focusTarget, query]);

  function changeSection(section: SettingsSectionId) {
    setActiveSection(section);
    setQuery("");
    setFocusTarget(null);
  }

  function selectSearchResult(item: SettingsSearchItem) {
    setActiveSection(item.section);
    setFocusTarget(item.id);
    setQuery("");
  }

  let content;
  if (normalizedQuery.length > 0) {
    content = <SettingsSearchResults results={searchResults} onSelect={selectSearchResult} />;
  } else {
    const update = (patch: Partial<SettingsModel>) => actions.updateSettings(patch);
    switch (activeSection) {
      case "general":
        content = <GeneralSettings settings={settings} onUpdate={update} />;
        break;
      case "appearance":
        content = <AppearanceSettings settings={settings} onUpdate={update} />;
        break;
      case "reading":
        content = <ReadingSettings settings={settings} onUpdate={update} />;
        break;
      case "reviewer":
        content = <ReviewerSettings settings={settings} onUpdate={update} />;
        break;
      case "generators":
        content = <QuizGeneratorSettingsPanel />;
        break;
    }
  }

  return (
    <Dialog.Root open={state.settingsOpen} onOpenChange={(open) => actions.setSettingsOpen(open)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className="ui-dialog settings-dialog">
          <SettingsWorkspace
            sections={SETTINGS_SECTIONS}
            activeSection={activeSection}
            query={query}
            resultCount={searchResults.length}
            onQueryChange={setQuery}
            onSectionChange={changeSection}
            onReset={() => setResetOpen(true)}
            saveStatus={state.settingsSaveStatus}
            saveError={state.settingsSaveError}
            onRetrySave={() => actions.retrySettingsSave()}
          >
            {content}
          </SettingsWorkspace>
          <Dialog.Root open={resetOpen} onOpenChange={setResetOpen}>
            <Dialog.Portal>
              <Dialog.Backdrop className="ui-backdrop" />
              <Dialog.Popup className="ui-dialog settings-reset-dialog">
                <Dialog.Title>Reset all local preferences?</Dialog.Title>
                <Dialog.Description>
                  This resets appearance, interface size, reading preferences, scan depth,
                  and reviewer ID, name, and email. Bundle files, recorded reviews, quiz
                  history, and quiz generator profiles are kept.
                </Dialog.Description>
                <div className="settings-reset-actions">
                  <Dialog.Close className="btn">Cancel</Dialog.Close>
                  <button type="button" className="btn primary" onClick={() => {
                    actions.updateSettings(DEFAULT_SETTINGS);
                    setResetOpen(false);
                  }}>Reset all preferences</button>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
