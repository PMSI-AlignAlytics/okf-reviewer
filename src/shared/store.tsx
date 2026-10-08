// Focused application state for local bundle browsing, explicit human review,
// and the bounded background lifecycle of quiz generation. It deliberately has
// no general agent, authoring, or staging state.

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Bundle,
  BundleGitStatus,
  BundleRoot,
  Concept,
  ConceptStatus,
  RecentBundle,
  Settings,
} from "@/shared/types.ts";
import type {
  ReviewConceptRequest,
  ReviewConceptResult,
} from "@/features/review/types.ts";
import type { ConceptReviewState } from "@/features/review/state.ts";
import type {
  ProviderAuthenticationGuidance,
  ProviderLoginMode,
  ProviderPreflight,
  QuizGenerationProgress,
  QuizGenerationState,
  QuizProviderKind,
  QuizProviderProfile,
  QuizScopePreview,
} from "@/features/quiz/types.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import { conceptById, indexIdForDir, indexNodeForId } from "@/shared/selectors.ts";
import { applyTheme } from "@/shared/theme.ts";
import * as ipc from "@/shared/ipc.ts";
import {
  isWindowMaximized,
  onWindowResized,
  openConceptWindow,
} from "@/shared/platform/window.ts";

export type PanelName = "sidebar" | "log" | "validation";
export type ReviewFacet = ConceptReviewState;
export type Lens = "navigate" | "filter";
export type LayoutMode = "reader";
export type WorkspaceArea = "reader" | "quizzes";
export interface QuizLaunch {
  conceptId: string;
  origin: "reader";
}

export interface BackgroundQuizGeneration {
  requestId: string;
  bundleRoot: string;
  scopeDescription: string;
  providerLabel: string;
  providerKind: QuizProviderKind;
  phase:
    | "checking-provider"
    | "authentication-required"
    | "checking-authentication"
    | "signing-in"
    | "generating"
    | "validating";
  authenticationMode: ProviderLoginMode | null;
  authenticationGuidance: ProviderAuthenticationGuidance | null;
  providerExecutable: string | null;
  providerVersion: string | null;
  state: QuizGenerationState;
  message: string;
}

export interface QuizGenerationNotification {
  requestId: string;
  bundleRoot: string;
  tone: "success" | "error" | "info";
  title: string;
  message: string;
  quizId: string | null;
  failureId: string | null;
}

export interface StartQuizGenerationInput {
  bundleRoot: string;
  preview: QuizScopePreview;
  profile: QuizProviderProfile;
}

export interface Tab {
  id: number;
  conceptId: string | null;
  back: string[];
  fwd: string[];
}

export interface PaneSizes {
  sidebar: number | null;
  reader: number | null;
}

interface BootTarget {
  folder: string;
  root: string;
  concept: string | null;
}

function parseBootTarget(): BootTarget | null {
  if (typeof location === "undefined") return null;
  const query = new URLSearchParams(location.search);
  const folder = query.get("folder");
  const root = query.get("root");
  if (!folder || !root) return null;
  return { folder, root, concept: query.get("concept") };
}

const bootTarget = parseBootTarget();

export function paneClamp(
  pane: "sidebar" | "reader",
): { min: number; max: number } {
  return pane === "sidebar"
    ? { min: 180, max: 520 }
    : { min: 360, max: 1_400 };
}

export interface State {
  folder: string | null;
  bundles: BundleRoot[];
  activeRoot: string | null;
  bundle: Bundle | null;
  bundleGitStatus: BundleGitStatus;
  loading: boolean;
  error: string | null;
  activeConceptId: string | null;
  back: string[];
  fwd: string[];
  tabs: Tab[];
  activeTabId: number;
  nextTabId: number;
  query: string;
  hiddenTypes: string[];
  activeTag: string | null;
  activeStatuses: ConceptStatus[];
  activeReviewStates: ReviewFacet[];
  lens: Lens;
  layout: LayoutMode;
  workspaceArea: WorkspaceArea;
  quizLaunch: QuizLaunch | null;
  quizGeneration: BackgroundQuizGeneration | null;
  quizNotification: QuizGenerationNotification | null;
  panels: Record<PanelName, boolean>;
  paneSizes: PaneSizes;
  recents: RecentBundle[];
  switcherOpen: boolean;
  settingsOpen: boolean;
  settings: Settings;
  settingsSaveStatus: "idle" | "saving" | "saved" | "error";
  settingsSaveError: string | null;
  searchFocusRequest: number;
  maximized: boolean;
}

function initialTab(): Tab {
  return { id: 1, conceptId: null, back: [], fwd: [] };
}

function makeInitialState(): State {
  const tab = initialTab();
  return {
    folder: null,
    bundles: [],
    activeRoot: null,
    bundle: null,
    bundleGitStatus: unavailableBundleGitStatus(),
    loading: false,
    error: null,
    activeConceptId: null,
    back: [],
    fwd: [],
    tabs: [tab],
    activeTabId: tab.id,
    nextTabId: 2,
    query: "",
    hiddenTypes: [],
    activeTag: null,
    activeStatuses: [],
    activeReviewStates: [],
    lens: "navigate",
    layout: "reader",
    workspaceArea: "reader",
    quizLaunch: null,
    quizGeneration: null,
    quizNotification: null,
    panels: { sidebar: true, log: false, validation: false },
    paneSizes: { sidebar: null, reader: null },
    recents: [],
    switcherOpen: false,
    settingsOpen: false,
    settings: DEFAULT_SETTINGS,
    settingsSaveStatus: "idle",
    settingsSaveError: null,
    searchFocusRequest: 0,
    maximized: false,
  };
}

type Message =
  | { type: "loading"; value: boolean }
  | { type: "error"; value: string | null }
  | { type: "open-folder"; folder: string; bundles: BundleRoot[] }
  | { type: "set-bundle"; root: string; bundle: Bundle }
  | { type: "set-bundle-git-status"; root: string; status: BundleGitStatus }
  | { type: "clear-bundle" }
  | { type: "select"; conceptId: string }
  | { type: "open-tab"; conceptId: string | null; background: boolean }
  | { type: "close-tab"; tabId: number }
  | { type: "activate-tab"; tabId: number }
  | { type: "cycle-tab"; direction: 1 | -1 }
  | { type: "move-tab"; tabId: number; to: number }
  | { type: "back" }
  | { type: "forward" }
  | { type: "query"; value: string }
  | { type: "focus-concept-search" }
  | { type: "settings-save"; status: State["settingsSaveStatus"]; error?: string }
  | { type: "toggle-type"; value: string }
  | { type: "show-all-types" }
  | { type: "tag"; value: string | null }
  | { type: "toggle-status"; value: ConceptStatus }
  | { type: "toggle-review"; value: ReviewFacet }
  | { type: "clear-lifecycle-review" }
  | { type: "lens"; value: Lens }
  | { type: "workspace-area"; value: WorkspaceArea }
  | { type: "quiz-launch"; value: QuizLaunch | null }
  | { type: "quiz-generation-start"; value: BackgroundQuizGeneration }
  | { type: "quiz-generation-progress"; value: QuizGenerationProgress }
  | {
      type: "quiz-generation-status";
      requestId: string;
      value: Partial<Pick<
        BackgroundQuizGeneration,
        | "phase"
        | "authenticationMode"
        | "authenticationGuidance"
        | "providerExecutable"
        | "providerVersion"
        | "message"
      >>;
    }
  | {
      type: "quiz-generation-finish";
      requestId: string;
      notification: QuizGenerationNotification;
    }
  | { type: "quiz-notification-dismiss" }
  | { type: "panel"; name: PanelName; value?: boolean }
  | { type: "pane-size"; pane: keyof PaneSizes; value: number | null }
  | { type: "recents"; value: RecentBundle[] }
  | { type: "switcher"; value: boolean }
  | { type: "settings-open"; value: boolean }
  | { type: "settings"; value: Settings }
  | { type: "maximized"; value: boolean };

function mirrorActiveTab(state: State, tabs: Tab[], activeTabId: number): State {
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return {
    ...state,
    tabs,
    activeTabId: active.id,
    activeConceptId: active.conceptId,
    back: active.back,
    fwd: active.fwd,
  };
}

function replaceTab(state: State, replacement: Tab): State {
  return mirrorActiveTab(
    state,
    state.tabs.map((tab) => tab.id === replacement.id ? replacement : tab),
    state.activeTabId,
  );
}

function defaultSelection(bundle: Bundle): string | null {
  const rootIndex = indexIdForDir("");
  if (indexNodeForId(bundle, rootIndex)) return rootIndex;
  return bundle.concepts[0]?.id ?? null;
}

function unavailableBundleGitStatus(): BundleGitStatus {
  return {
    available: false,
    headRevision: null,
    comparisonMode: "unavailable",
    currentBranch: null,
    defaultBranch: null,
    baseRevision: null,
    modifiedConceptIds: [],
    deletedPaths: [],
    lineChangesByConcept: {},
    trustRequired: false,
    repositoryRoot: null,
    message: null,
  };
}

async function loadBundleGitStatus(root: string): Promise<BundleGitStatus> {
  try {
    return await ipc.readBundleGitStatus(root);
  } catch {
    return unavailableBundleGitStatus();
  }
}

function reducer(state: State, message: Message): State {
  switch (message.type) {
    case "loading":
      return { ...state, loading: message.value, error: null };
    case "error":
      return { ...state, error: message.value, loading: false };
    case "open-folder":
      return {
        ...state,
        folder: message.folder,
        bundles: message.bundles,
        loading: message.bundles.length > 0,
        error: null,
      };
    case "set-bundle": {
      const existing = state.activeConceptId;
      const conceptId =
        existing && (conceptById(message.bundle, existing) || indexNodeForId(message.bundle, existing))
          ? existing
          : defaultSelection(message.bundle);
      const tab = {
        id: 1,
        conceptId,
        back: [],
        fwd: [],
      };
      return {
        ...state,
        activeRoot: message.root,
        bundle: message.bundle,
        bundleGitStatus:
          state.activeRoot === message.root
            ? state.bundleGitStatus
            : unavailableBundleGitStatus(),
        loading: false,
        error: null,
        tabs: [tab],
        activeTabId: tab.id,
        nextTabId: 2,
        activeConceptId: tab.conceptId,
        back: [],
        fwd: [],
        query: "",
        hiddenTypes: [],
        activeTag: null,
        activeStatuses: [],
        activeReviewStates: [],
        switcherOpen: false,
      };
    }
    case "set-bundle-git-status":
      return state.activeRoot === message.root
        ? { ...state, bundleGitStatus: message.status }
        : state;
    case "clear-bundle": {
      const clean = makeInitialState();
      return {
        ...clean,
        settings: state.settings,
        recents: state.recents,
        maximized: state.maximized,
        quizGeneration: state.quizGeneration,
        quizNotification: state.quizNotification,
      };
    }
    case "select": {
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!active || active.conceptId === message.conceptId) return state;
      return replaceTab(state, {
        ...active,
        conceptId: message.conceptId,
        back: active.conceptId ? [...active.back, active.conceptId] : active.back,
        fwd: [],
      });
    }
    case "open-tab": {
      const tab: Tab = {
        id: state.nextTabId,
        conceptId: message.conceptId,
        back: [],
        fwd: [],
      };
      const tabs = [...state.tabs, tab];
      const next = { ...state, nextTabId: state.nextTabId + 1 };
      return mirrorActiveTab(
        next,
        tabs,
        message.background ? state.activeTabId : tab.id,
      );
    }
    case "close-tab": {
      if (state.tabs.length === 1) {
        return replaceTab(state, { ...state.tabs[0], conceptId: null, back: [], fwd: [] });
      }
      const index = state.tabs.findIndex((tab) => tab.id === message.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== message.tabId);
      const activeTabId = state.activeTabId === message.tabId
        ? tabs[Math.min(index, tabs.length - 1)].id
        : state.activeTabId;
      return mirrorActiveTab(state, tabs, activeTabId);
    }
    case "activate-tab":
      return state.tabs.some((tab) => tab.id === message.tabId)
        ? mirrorActiveTab(state, state.tabs, message.tabId)
        : state;
    case "cycle-tab": {
      if (state.tabs.length < 2) return state;
      const current = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const next = (current + message.direction + state.tabs.length) % state.tabs.length;
      return mirrorActiveTab(state, state.tabs, state.tabs[next].id);
    }
    case "move-tab": {
      const from = state.tabs.findIndex((tab) => tab.id === message.tabId);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(message.to, state.tabs.length - 1));
      if (from === to) return state;
      const tabs = [...state.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      return mirrorActiveTab(state, tabs, state.activeTabId);
    }
    case "back": {
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!active || active.back.length === 0) return state;
      const conceptId = active.back.at(-1) ?? null;
      return replaceTab(state, {
        ...active,
        conceptId,
        back: active.back.slice(0, -1),
        fwd: active.conceptId ? [active.conceptId, ...active.fwd] : active.fwd,
      });
    }
    case "forward": {
      const active = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!active || active.fwd.length === 0) return state;
      const [conceptId, ...fwd] = active.fwd;
      return replaceTab(state, {
        ...active,
        conceptId,
        back: active.conceptId ? [...active.back, active.conceptId] : active.back,
        fwd,
      });
    }
    case "query":
      return { ...state, query: message.value };
    case "focus-concept-search":
      return {
        ...state,
        workspaceArea: "reader",
        lens: "navigate",
        panels: { ...state.panels, sidebar: true },
        searchFocusRequest: state.searchFocusRequest + 1,
      };
    case "settings-save":
      return { ...state, settingsSaveStatus: message.status, settingsSaveError: message.error ?? null };
    case "toggle-type":
      return {
        ...state,
        hiddenTypes: state.hiddenTypes.includes(message.value)
          ? state.hiddenTypes.filter((type) => type !== message.value)
          : [...state.hiddenTypes, message.value],
      };
    case "show-all-types":
      return { ...state, hiddenTypes: [] };
    case "tag":
      return { ...state, activeTag: message.value };
    case "toggle-status":
      return {
        ...state,
        activeStatuses: state.activeStatuses.includes(message.value)
          ? state.activeStatuses.filter((status) => status !== message.value)
          : [...state.activeStatuses, message.value],
      };
    case "toggle-review":
      return {
        ...state,
        activeReviewStates: state.activeReviewStates.includes(message.value)
          ? state.activeReviewStates.filter((review) => review !== message.value)
          : [...state.activeReviewStates, message.value],
      };
    case "clear-lifecycle-review":
      return { ...state, activeStatuses: [], activeReviewStates: [] };
    case "lens":
      return { ...state, lens: message.value };
    case "workspace-area":
      return { ...state, workspaceArea: message.value };
    case "quiz-launch":
      return { ...state, quizLaunch: message.value };
    case "quiz-generation-start":
      return {
        ...state,
        quizGeneration: message.value,
        quizNotification: null,
      };
    case "quiz-generation-progress":
      return state.quizGeneration?.requestId === message.value.requestId
        ? {
            ...state,
            quizGeneration: {
              ...state.quizGeneration,
              state: message.value.state,
              phase: message.value.state === "validating"
                ? "validating"
                : state.quizGeneration.phase,
              message: message.value.message,
            },
          }
        : state;
    case "quiz-generation-status":
      return state.quizGeneration?.requestId === message.requestId
        ? {
            ...state,
            quizGeneration: {
              ...state.quizGeneration,
              ...message.value,
            },
          }
        : state;
    case "quiz-generation-finish":
      return state.quizGeneration?.requestId === message.requestId
        ? {
            ...state,
            quizGeneration: null,
            quizNotification: message.notification,
          }
        : state;
    case "quiz-notification-dismiss":
      return { ...state, quizNotification: null };
    case "panel":
      return {
        ...state,
        panels: {
          ...state.panels,
          [message.name]: message.value ?? !state.panels[message.name],
        },
      };
    case "pane-size": {
      const value = message.value === null
        ? null
        : Math.round(Math.min(
            paneClamp(message.pane).max,
            Math.max(paneClamp(message.pane).min, message.value),
          ));
      return { ...state, paneSizes: { ...state.paneSizes, [message.pane]: value } };
    }
    case "recents":
      return { ...state, recents: message.value };
    case "switcher":
      return { ...state, switcherOpen: message.value };
    case "settings-open":
      return { ...state, settingsOpen: message.value };
    case "settings":
      return { ...state, settings: message.value };
    case "maximized":
      return { ...state, maximized: message.value };
  }
}

export interface Actions {
  openFolder(): Promise<void>;
  openFolderPath(folder: string): Promise<Bundle | null>;
  selectBundle(root: string, folder?: string): Promise<Bundle | null>;
  reloadActiveBundle(): Promise<Bundle | null>;
  refreshBundleGitStatus(): Promise<void>;
  reviewConcept(input: ReviewConceptRequest): Promise<ReviewConceptResult>;
  trustActiveRepository(repositoryRoot: string): Promise<void>;
  openRecentBundle(entry: RecentBundle): Promise<void>;
  pinBundle(root: string): Promise<void>;
  forgetBundle(root: string): Promise<void>;
  setSwitcher(open: boolean): void;
  rescan(): Promise<void>;
  selectConcept(id: string): void;
  openInNewTab(id: string | null, options?: { background?: boolean }): void;
  closeTab(tabId?: number): void;
  activateTab(tabId: number): void;
  cycleTab(direction: 1 | -1): void;
  moveTab(tabId: number, to: number): void;
  popOutTab(tabId?: number): Promise<void>;
  back(): void;
  forward(): void;
  setQuery(query: string): void;
  focusConceptSearch(): void;
  toggleType(type: string): void;
  showAllTypes(): void;
  setTag(tag: string | null): void;
  toggleStatus(status: ConceptStatus): void;
  toggleReviewState(review: ReviewFacet): void;
  clearLifecycleReview(): void;
  setLens(lens: Lens): void;
  setWorkspaceArea(area: WorkspaceArea): void;
  startQuickQuiz(conceptId: string): void;
  clearQuizLaunch(): void;
  startQuizGeneration(input: StartQuizGenerationInput): boolean;
  chooseQuizAuthentication(mode: ProviderLoginMode): void;
  recheckQuizAuthentication(): void;
  cancelQuizGeneration(): void;
  dismissQuizNotification(): void;
  openQuizNotification(): Promise<void>;
  setPaneSize(pane: keyof PaneSizes, value: number | null): void;
  togglePanel(name: PanelName, value?: boolean): void;
  setSettingsOpen(open: boolean): void;
  updateSettings(patch: Partial<Settings>): void;
  retrySettingsSave(): void;
  flushSettings(): Promise<void>;
  openExternal(url: string): void;
  openLinkedDocument(root: string, fromId: string, href: string): Promise<void>;
}

const StateContext = createContext<State | null>(null);
const ActionsContext = createContext<Actions | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);
  const stateRef = useRef(state);
  const settingsVersionRef = useRef(0);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const backgroundQuizRequestRef = useRef<string | null>(null);
  const backgroundQuizCancelRef = useRef(false);
  type AuthenticationAction = ProviderLoginMode | "check-again" | null;
  const backgroundQuizAuthenticationChoiceRef = useRef<
    ((action: AuthenticationAction) => void) | null
  >(null);
  const quizGenerationCancelled = () => backgroundQuizCancelRef.current;
  useEffect(() => {
    stateRef.current = state;
  });

  const [actions] = useState<Actions>(() => {
    const appActions: Actions = {
      async openFolder() {
        const folder = await ipc.pickFolder();
        if (folder) await appActions.openFolderPath(folder);
      },
      async openFolderPath(folder) {
        dispatch({ type: "loading", value: true });
        try {
          const bundles = await ipc.scanBundles(
            folder,
            stateRef.current.settings.scanMaxDepth,
          );
          dispatch({ type: "open-folder", folder, bundles });
          if (bundles.length === 0) return null;
          return await appActions.selectBundle(bundles[0].root, folder);
        } catch (error) {
          dispatch({ type: "error", value: String(error) });
          return null;
        }
      },
      async selectBundle(root, folder) {
        dispatch({ type: "loading", value: true });
        try {
          const [bundle, gitStatus] = await Promise.all([
            ipc.readBundle(root),
            loadBundleGitStatus(root),
          ]);
          dispatch({ type: "set-bundle", root, bundle });
          dispatch({ type: "set-bundle-git-status", root, status: gitStatus });
          const grantedFolder = folder ?? stateRef.current.folder;
          if (grantedFolder) {
            const types = [...new Set(
              bundle.concepts.map((concept) => concept.type).filter(Boolean),
            )].sort();
            const recents = await ipc.pushRecentBundle({
              root,
              folder: grantedFolder,
              name: bundle.name,
              conceptCount: bundle.concepts.length,
              types,
            });
            dispatch({ type: "recents", value: recents });
          }
          return bundle;
        } catch (error) {
          dispatch({ type: "error", value: String(error) });
          return null;
        }
      },
      async reloadActiveBundle() {
        const root = stateRef.current.activeRoot;
        if (!root) return null;
        const [bundle, gitStatus] = await Promise.all([
          ipc.readBundle(root),
          loadBundleGitStatus(root),
        ]);
        dispatch({ type: "set-bundle", root, bundle });
        dispatch({ type: "set-bundle-git-status", root, status: gitStatus });
        return bundle;
      },
      async refreshBundleGitStatus() {
        const root = stateRef.current.activeRoot;
        if (!root) return;
        const status = await loadBundleGitStatus(root);
        dispatch({ type: "set-bundle-git-status", root, status });
      },
      async reviewConcept(input) {
        const result = await ipc.reviewConcept(input);
        if (stateRef.current.activeRoot === input.bundleRoot) {
          const [bundle, gitStatus] = await Promise.all([
            ipc.readBundle(input.bundleRoot),
            loadBundleGitStatus(input.bundleRoot),
          ]);
          dispatch({ type: "set-bundle", root: input.bundleRoot, bundle });
          dispatch({
            type: "set-bundle-git-status",
            root: input.bundleRoot,
            status: gitStatus,
          });
        }
        return result;
      },
      async trustActiveRepository(repositoryRoot) {
        const root = stateRef.current.activeRoot;
        if (!root) throw new Error("No bundle is currently open.");
        const status = await ipc.trustBundleRepository(root, repositoryRoot);
        dispatch({ type: "set-bundle-git-status", root, status });
      },
      async openRecentBundle(entry) {
        dispatch({ type: "loading", value: true });
        try {
          const bundles = await ipc.scanBundles(
            entry.folder,
            stateRef.current.settings.scanMaxDepth,
          );
          dispatch({ type: "open-folder", folder: entry.folder, bundles });
          const root = bundles.some((bundle) => bundle.root === entry.root)
            ? entry.root
            : bundles[0]?.root;
          if (root) await appActions.selectBundle(root, entry.folder);
          else dispatch({ type: "loading", value: false });
        } catch (error) {
          dispatch({ type: "error", value: String(error) });
        }
      },
      async pinBundle(root) {
        dispatch({ type: "recents", value: await ipc.pinBundle(root) });
      },
      async forgetBundle(root) {
        const forgotten = stateRef.current.recents.find((entry) => entry.root === root);
        const remaining = await ipc.forgetBundle(root);
        const wasActive = stateRef.current.activeRoot === root;
        if (wasActive) dispatch({ type: "clear-bundle" });
        dispatch({ type: "recents", value: remaining });
        if (
          forgotten &&
          !remaining.some((entry) => entry.folder === forgotten.folder)
        ) {
          await ipc.revokeBundleGrant(forgotten.folder);
        }
      },
      setSwitcher(open) {
        dispatch({ type: "switcher", value: open });
      },
      async rescan() {
        const { folder, activeRoot } = stateRef.current;
        if (!folder) return;
        const bundles = await ipc.scanBundles(
          folder,
          stateRef.current.settings.scanMaxDepth,
        );
        dispatch({ type: "open-folder", folder, bundles });
        const root = activeRoot && bundles.some((bundle) => bundle.root === activeRoot)
          ? activeRoot
          : bundles[0]?.root;
        if (root) await appActions.selectBundle(root, folder);
      },
      selectConcept(id) {
        dispatch({ type: "workspace-area", value: "reader" });
        dispatch({ type: "select", conceptId: id });
      },
      openInNewTab(id, options) {
        dispatch({
          type: "open-tab",
          conceptId: id,
          background: options?.background ?? false,
        });
      },
      closeTab(tabId) {
        dispatch({ type: "close-tab", tabId: tabId ?? stateRef.current.activeTabId });
      },
      activateTab(tabId) {
        dispatch({ type: "activate-tab", tabId });
      },
      cycleTab(direction) {
        dispatch({ type: "cycle-tab", direction });
      },
      moveTab(tabId, to) {
        dispatch({ type: "move-tab", tabId, to });
      },
      async popOutTab(tabId) {
        const current = stateRef.current;
        const id = tabId ?? current.activeTabId;
        const tab = current.tabs.find((candidate) => candidate.id === id);
        if (!tab || !current.folder || !current.activeRoot) return;
        const opened = await openConceptWindow(
          current.folder,
          current.activeRoot,
          tab.conceptId,
        );
        if (opened && stateRef.current.tabs.length > 1) {
          dispatch({ type: "close-tab", tabId: id });
        }
      },
      back() {
        dispatch({ type: "back" });
      },
      forward() {
        dispatch({ type: "forward" });
      },
      setQuery(query) {
        dispatch({ type: "query", value: query });
      },
      focusConceptSearch() {
        if (!stateRef.current.bundle) return;
        dispatch({ type: "focus-concept-search" });
      },
      toggleType(type) {
        dispatch({ type: "toggle-type", value: type });
      },
      showAllTypes() {
        dispatch({ type: "show-all-types" });
      },
      setTag(tag) {
        dispatch({ type: "tag", value: tag });
      },
      toggleStatus(status) {
        dispatch({ type: "toggle-status", value: status });
      },
      toggleReviewState(review) {
        dispatch({ type: "toggle-review", value: review });
      },
      clearLifecycleReview() {
        dispatch({ type: "clear-lifecycle-review" });
      },
      setLens(lens) {
        dispatch({ type: "lens", value: lens });
      },
      setWorkspaceArea(area) {
        dispatch({ type: "workspace-area", value: area });
      },
      startQuickQuiz(conceptId) {
        dispatch({ type: "quiz-launch", value: { conceptId, origin: "reader" } });
        dispatch({ type: "workspace-area", value: "quizzes" });
      },
      clearQuizLaunch() {
        dispatch({ type: "quiz-launch", value: null });
      },
      startQuizGeneration({ bundleRoot, preview, profile }) {
        if (backgroundQuizRequestRef.current !== null) return false;
        const requestId = preview.requestId;
        backgroundQuizRequestRef.current = requestId;
        backgroundQuizCancelRef.current = false;
        dispatch({
          type: "quiz-generation-start",
          value: {
            requestId,
            bundleRoot,
            scopeDescription: preview.scopeDescription,
            providerLabel: profile.label,
            providerKind: profile.kind,
            phase: "checking-provider",
            authenticationMode: null,
            authenticationGuidance: null,
            providerExecutable: null,
            providerVersion: null,
            state: "generating",
            message: profile.kind === "codex-cli"
              ? "Checking Codex sign-in before background generation…"
              : "Checking quiz generator setup…",
          },
        });
        dispatch({ type: "quiz-launch", value: null });
        dispatch({ type: "workspace-area", value: "reader" });

        const finish = (notification: QuizGenerationNotification) => {
          const pendingAuthentication = backgroundQuizAuthenticationChoiceRef.current;
          backgroundQuizAuthenticationChoiceRef.current = null;
          pendingAuthentication?.(null);
          backgroundQuizRequestRef.current = null;
          backgroundQuizCancelRef.current = false;
          dispatch({
            type: "quiz-generation-finish",
            requestId,
            notification,
          });
        };
        const cancelled = () => finish({
          requestId,
          bundleRoot,
          tone: "info",
          title: "Quiz generation cancelled",
          message: "No quiz was created.",
          quizId: null,
          failureId: null,
        });
        const requestAuthenticationAction = (checked: ProviderPreflight) =>
          new Promise<AuthenticationAction>((resolve) => {
            backgroundQuizAuthenticationChoiceRef.current = resolve;
            dispatch({
              type: "quiz-generation-status",
              requestId,
              value: {
                phase: "authentication-required",
                authenticationMode: null,
                authenticationGuidance: checked.authenticationGuidance,
                providerExecutable: checked.executable,
                providerVersion: checked.version,
                message: checked.message,
              },
            });
          });
        const ensureProviderAuthentication = async (
          initial: ProviderPreflight,
        ): Promise<boolean> => {
          let checked = initial;
          while (
            !checked.available
            && checked.authenticationRequired
            && (profile.kind === "codex-cli" || profile.kind === "claude-cli")
          ) {
            const action = await requestAuthenticationAction(checked);
            if (!action || quizGenerationCancelled()) return false;
            if (profile.kind === "codex-cli") {
              if (action !== "check-again") continue;
              dispatch({
                type: "quiz-generation-status",
                requestId,
                value: {
                  phase: "checking-authentication",
                  authenticationMode: null,
                  message: "Checking the Codex CLI sign-in status…",
                },
              });
              checked = await ipc.quizProviderPreflight(profile.id, profile.model);
              if (quizGenerationCancelled()) return false;
              continue;
            }
            if (action === "check-again") continue;
            dispatch({
              type: "quiz-generation-status",
              requestId,
              value: {
                phase: "signing-in",
                authenticationMode: action,
                message: `Complete ${profile.label} sign-in in the command window. It will stay open while sign-in is active.`,
              },
            });
            const login = await ipc.quizProviderLogin(profile.id, action).then(
              (result) => result,
              (problem: unknown) => ({
                authenticated: false,
                cancelled: false,
                message: String(problem),
              }),
            );
            if (quizGenerationCancelled() || login.cancelled) return false;
            checked = login.authenticated
              ? { ...checked, available: true, authenticationRequired: false }
              : { ...checked, message: login.message };
          }
          if (!checked.available) throw new Error(checked.message);
          return true;
        };

        void (async () => {
          try {
            const checked = await ipc.quizProviderPreflight(profile.id, profile.model);
            if (backgroundQuizCancelRef.current) {
              cancelled();
              return;
            }
            if (!await ensureProviderAuthentication(checked)) {
              cancelled();
              return;
            }
            while (!quizGenerationCancelled()) {
              dispatch({
                type: "quiz-generation-status",
                requestId,
                value: {
                  phase: "generating",
                  authenticationMode: null,
                  authenticationGuidance: null,
                  message: "Generating quiz in the background…",
                },
              });
              const outcome = await ipc.generateQuiz(requestId, profile.id, profile.model);
              if (
                outcome.state === "authentication-required"
                && (profile.kind === "codex-cli" || profile.kind === "claude-cli")
              ) {
                const rechecked = await ipc.quizProviderPreflight(profile.id, profile.model);
                const requirement = {
                  ...rechecked,
                  available: false,
                  authenticationRequired: true,
                  message: outcome.message,
                };
                if (!await ensureProviderAuthentication(requirement)) {
                  cancelled();
                  return;
                }
                continue;
              }
              if (outcome.state === "ready" && outcome.quizId) {
                finish({
                  requestId,
                  bundleRoot,
                  tone: "success",
                  title: "Quiz ready",
                  message: outcome.warnings.length > 0
                    ? `${outcome.message} ${outcome.warnings.join(" ")}`
                    : outcome.message,
                  quizId: outcome.quizId,
                  failureId: null,
                });
                return;
              }
              if (outcome.state === "cancelled") {
                cancelled();
                return;
              }
              finish({
                requestId,
                bundleRoot,
                tone: outcome.state === "insufficient-evidence" ? "info" : "error",
                title: outcome.state === "insufficient-evidence"
                  ? "Quiz needs more evidence"
                  : "Quiz generation failed",
                message: [
                  outcome.message,
                  ...outcome.warnings,
                  ...outcome.issues.map((issue) => issue.message),
                ].filter(Boolean).join(" "),
                quizId: null,
                failureId: outcome.failureId,
              });
              return;
            }
            cancelled();
          } catch (problem) {
            finish({
              requestId,
              bundleRoot,
              tone: "error",
              title: "Quiz generation failed",
              message: String(problem),
              quizId: null,
              failureId: null,
            });
          }
        })();
        return true;
      },
      chooseQuizAuthentication(mode) {
        const pending = backgroundQuizAuthenticationChoiceRef.current;
        if (pending) {
          backgroundQuizAuthenticationChoiceRef.current = null;
          pending(mode);
        }
      },
      recheckQuizAuthentication() {
        const pending = backgroundQuizAuthenticationChoiceRef.current;
        if (pending) {
          backgroundQuizAuthenticationChoiceRef.current = null;
          pending("check-again");
        }
      },
      cancelQuizGeneration() {
        const requestId = backgroundQuizRequestRef.current;
        if (!requestId) return;
        backgroundQuizCancelRef.current = true;
        dispatch({
          type: "quiz-generation-progress",
          value: {
            requestId,
            state: "cancelled",
            message: "Cancelling quiz generation…",
          },
        });
        const pendingAuthentication = backgroundQuizAuthenticationChoiceRef.current;
        backgroundQuizAuthenticationChoiceRef.current = null;
        pendingAuthentication?.(null);
        void ipc.cancelQuizGeneration(requestId).catch(() => undefined);
        if (
          stateRef.current.quizGeneration?.providerKind === "claude-cli"
          && stateRef.current.quizGeneration.phase === "signing-in"
        ) {
          void ipc.cancelQuizProviderLogin().catch(() => undefined);
        }
      },
      dismissQuizNotification() {
        dispatch({ type: "quiz-notification-dismiss" });
      },
      async openQuizNotification() {
        const notification = stateRef.current.quizNotification;
        if (!notification || (!notification.quizId && !notification.failureId)) return;
        if (stateRef.current.activeRoot !== notification.bundleRoot) {
          const bundle = await appActions.selectBundle(notification.bundleRoot);
          if (!bundle) return;
        }
        dispatch({ type: "quiz-notification-dismiss" });
        dispatch({ type: "workspace-area", value: "quizzes" });
      },
      setPaneSize(pane, value) {
        dispatch({ type: "pane-size", pane, value });
      },
      togglePanel(name, value) {
        dispatch({ type: "panel", name, value });
      },
      setSettingsOpen(open) {
        dispatch({ type: "settings-open", value: open });
      },
      updateSettings(patch) {
        const settings = { ...stateRef.current.settings, ...patch };
        stateRef.current = { ...stateRef.current, settings };
        dispatch({ type: "settings", value: settings });
        dispatch({ type: "settings-save", status: "saving" });
        const version = ++settingsVersionRef.current;
        // Serialize snapshots so a slower earlier save cannot overwrite a
        // newer preference. Only the latest snapshot controls visible feedback.
        settingsSaveQueueRef.current = settingsSaveQueueRef.current
          .then(() => ipc.saveSettings(settings))
          .then(() => {
            if (version === settingsVersionRef.current) {
              dispatch({ type: "settings-save", status: "saved" });
            }
          }, (error: unknown) => {
            if (version === settingsVersionRef.current) {
              dispatch({
                type: "settings-save",
                status: "error",
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
      },
      retrySettingsSave() {
        appActions.updateSettings({});
      },
      async flushSettings() {
        await settingsSaveQueueRef.current;
        // Recheck the current snapshot and propagate failure before an update exits.
        await ipc.saveSettings(stateRef.current.settings);
      },
      openExternal(url) {
        void ipc.openExternal(url);
      },
      openLinkedDocument(root, fromId, href) {
        return ipc.openLinkedDocument(root, fromId, href);
      },
    };
    return appActions;
  });

  useEffect(() => {
    void (async () => {
      const settings = await ipc.loadSettings();
      stateRef.current = { ...stateRef.current, settings };
      dispatch({ type: "settings", value: settings });
      if (bootTarget) {
        const bundles = await ipc.scanBundles(
          bootTarget.folder,
          settings.scanMaxDepth,
        );
        dispatch({
          type: "open-folder",
          folder: bootTarget.folder,
          bundles,
        });
        const root = bundles.some((bundle) => bundle.root === bootTarget.root)
          ? bootTarget.root
          : bundles[0]?.root;
        if (bootTarget.concept) actions.selectConcept(bootTarget.concept);
        if (root) await actions.selectBundle(root, bootTarget.folder);
        return;
      }
      const recents = await ipc.recentBundles();
      dispatch({ type: "recents", value: recents });
      if (recents.length > 0 && ipc.isTauri()) {
        await actions.openRecentBundle(recents[0]);
      }
    })();
    // Boot once. The action object is stable and reads current state through
    // stateRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    let dispose: () => void = () => undefined;
    void ipc.onQuizGenerationProgress((progress) => {
      if (active) dispatch({ type: "quiz-generation-progress", value: progress });
    }).then((unlisten) => {
      if (active) dispose = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!ipc.isTauri()) return;
    let dispose: () => void = () => undefined;
    const sync = () => {
      void isWindowMaximized().then((maximized) =>
        dispatch({ type: "maximized", value: maximized })
      );
    };
    sync();
    void onWindowResized(sync).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose();
  }, []);

  useEffect(() => {
    applyTheme(state.settings.theme, state.settings.reduceMotion);
    if (state.settings.theme !== "system" || typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () =>
      applyTheme("system", stateRef.current.settings.reduceMotion);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [state.settings.theme, state.settings.reduceMotion]);

  useEffect(() => {
    const root = state.activeRoot;
    if (!root) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void ipc.startWatch(root, () => {
      void Promise.all([ipc.readBundle(root), loadBundleGitStatus(root)]).then(
        ([bundle, gitStatus]) => {
          if (cancelled) return;
          dispatch({ type: "set-bundle", root, bundle });
          dispatch({ type: "set-bundle-git-status", root, status: gitStatus });
        },
      );
    }).then((stop) => {
      if (cancelled) stop();
      else dispose = stop;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [state.activeRoot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshGitStatus = () => {
      const root = stateRef.current.activeRoot;
      if (!root) return;
      void loadBundleGitStatus(root).then((status) => {
        dispatch({ type: "set-bundle-git-status", root, status });
      });
    };
    window.addEventListener("focus", refreshGitStatus);
    return () => window.removeEventListener("focus", refreshGitStatus);
  }, []);

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): State {
  const state = useContext(StateContext);
  if (state === null) throw new Error("useAppState must be used within AppProvider");
  return state;
}

export function useAppActions(): Actions {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error("useAppActions must be used within AppProvider");
  return actions;
}

export function useApp() {
  return { state: useAppState(), actions: useAppActions() };
}

export function useActiveConcept(): Concept | null {
  const state = useAppState();
  return conceptById(state.bundle, state.activeConceptId);
}
