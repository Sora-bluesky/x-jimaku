import type {
  TranslationPath,
} from "../shared/messages";
import type {
  CaptionDisplayLogSink,
} from "../shared/caption-display-log";
import {
  CAPTION_FADE_MS,
  CAPTION_VISIBLE_MS,
  CUE_ACCELERATED_DISPLAY_MS,
  CUE_MINIMUM_DISPLAY_MS,
  MAX_WAITING_CUES,
} from "../shared/explicit-stop-drain";
import {
  INITIALIZATION_PROGRESS_CEILING,
} from "../shared/initialization-progress";
import {
  cueDisplayDurationMs,
  decideCueQueueDiscipline,
  retainAccelerationUntilDrained,
} from "./cue-queue";
import {
  MAX_CUE_UNITS,
  MAX_LINE_UNITS,
  createCaptionTextMeasurer,
  deriveLineUnitBudget,
  displayUnits,
  splitCueText,
  wrapCueText,
} from "./cue-text";
import type {
  SilentInputHintVariant,
} from "./silent-hint";

export {
  CUE_ACCELERATED_DISPLAY_MS,
  CUE_MINIMUM_DISPLAY_MS,
  MAX_CUE_UNITS,
  MAX_WAITING_CUES,
  splitCueText,
  wrapCueText,
};

const HOST_ID = "xjsub-host";
export const CUE_ACCELERATION_THRESHOLD = 2;
const CUE_DROP_WARNING_INTERVAL_MS = 5_000;
const MAX_ORIGINAL_CHARS = 140;
const MAX_LEDGER_ENTRIES = 400;
const PRIMARY_LINE_HEIGHT = 1.16;
const ORIGINAL_FONT_SCALE = 0.68;
const ORIGINAL_LINE_HEIGHT = 1.18;
const TENTATIVE_FONT_SCALE = 0.62;
const TENTATIVE_LINE_HEIGHT = 1.18;
const MUTATION_DEBOUNCE_MS = 500;
const CAPTION_PRIMARY_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const CAPTION_PRIMARY_FONT_WEIGHT = "650";
const MAX_OTHER_VIDEOS = 6;
const STABLE_FRAMES_BEFORE_IDLE = 10;
const RECT_COMPARISON_EPSILON_PX = 0.1;

interface RectSnapshot {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface OtherVideoLayout {
  video: HTMLVideoElement;
  rect: RectSnapshot | null;
}

interface LayoutSnapshot {
  target: HTMLVideoElement | null;
  targetRect: RectSnapshot | null;
  otherVideos: readonly OtherVideoLayout[];
}

interface CueData {
  cueId: string;
  sourceIds: readonly number[];
  primaryText: string;
  originalText: string;
  sourceText: string;
  formattedPrimary: string;
  fallback?: boolean;
}

type CaptionPage = readonly [
  string,
  string,
];

interface ActiveCue {
  data: CueData;
  pages: readonly CaptionPage[];
  pageIndex: number;
  shownAt: number;
}

interface SuspendedCaptionTimer {
  remainingMs: number;
  revision: number;
}

export interface CaptionLine {
  id: number;
  text: string;
  final: boolean;
  at: string;
  ja?: string;
  fallback?: boolean;
}

export type CaptionOverlayStatus =
  | "loadingModel"
  | "running"
  | "error";

export interface CaptionOverlayOptions {
  getTargetVideo(): HTMLVideoElement | null;
  buildStamp: string;
  showOriginal: boolean;
  showTentative: boolean;
  onCaptionFadeOut?(): void;
  displayLog?: CaptionDisplayLogSink;
}

export class CaptionOverlay {
  private readonly options:
    CaptionOverlayOptions;
  private readonly showOriginal: boolean;
  private readonly showTentative: boolean;
  private readonly host: HTMLDivElement;
  private readonly captionStack:
    HTMLDivElement;
  private readonly translationBadge:
    HTMLDivElement;
  private readonly captionLine:
    HTMLDivElement;
  private readonly cueContainer:
    HTMLDivElement;
  private readonly cueElement:
    HTMLDivElement;
  private readonly primaryLines:
    readonly [
      HTMLDivElement,
      HTMLDivElement,
    ];
  private readonly originalLine:
    HTMLDivElement;
  private readonly captionLedger:
    HTMLDivElement;
  private readonly tentativeLine:
    HTMLDivElement;
  private readonly targetChip:
    HTMLDivElement;
  private readonly targetDot:
    HTMLSpanElement;
  private readonly targetText:
    HTMLSpanElement;
  private readonly otherLayer:
    HTMLDivElement;
  private readonly resizeObserver:
    ResizeObserver;
  private readonly mutationObserver:
    MutationObserver;
  private readonly cueMutationObserver:
    MutationObserver;

  private readonly otherBadges =
    new Map<HTMLVideoElement, HTMLDivElement>();
  private readonly pendingFinals =
    new Map<number, CaptionLine>();
  private readonly acceptedFinalIds =
    new Set<number>();
  private readonly waitingCues: CueData[] = [];
  private readonly cueTextSnapshots =
    new WeakMap<Element, string>();
  private lastAcceptedPrimary = "";
  private lastAcceptedSource = "";
  private lastAcceptedKind:
    | "translated"
    | "fallback"
    | null = null;

  private targetVideo:
    | HTMLVideoElement
    | null = null;
  private mutationRoot: Node | null = null;
  private status: CaptionOverlayStatus =
    "loadingModel";
  private translationPath:
    | TranslationPath
    | null = null;
  private progress: number | undefined;
  private activeCue: ActiveCue | null = null;
  /**
   * The page currently on screen, kept so it can be logged again when the
   * layout hides the stack and later shows it. Dwell is what the reading-speed
   * numbers are computed from, so an interval where nothing was visible must
   * not sit inside one.
   */
  private shownPage: {
    activeCue: ActiveCue;
    pageIndex: number;
    firstLine: string;
    secondLine: string;
    originalText: string;
  } | null = null;
  private captionStackVisible = true;
  private highestSeenFinalId:
    | number
    | null = null;
  private clearWatermarkId:
    | number
    | null = null;
  private tentativeId: number | null = null;
  private tentativeAt: string | null = null;
  private deferredTentative:
    | CaptionLine
    | null = null;
  private deferredTentativeClearThroughId:
    | number
    | null = null;
  private cueMutationCount = 0;
  private droppedCueCount = 0;
  private droppedCuesSinceLastReport = 0;
  private lastCueDropWarningAt:
    | number
    | null = null;
  private acceleratedUntilDrained = false;
  private captionRevision = 0;
  private captionBarEnabled = true;
  private lineUnitBudget = MAX_LINE_UNITS;
  private captionInnerWidth = 0;
  private readonly textMeasurer =
    createCaptionTextMeasurer();
  private silentInputHint:
    | SilentInputHintVariant
    | null = null;
  private playbackPaused = false;
  private playbackPausedAt:
    | number
    | null = null;
  private captionFadeDeadline:
    | number
    | null = null;
  private captionRemovalDeadline:
    | number
    | null = null;
  private captionFadeRevision:
    | number
    | null = null;
  private captionRemovalRevision:
    | number
    | null = null;
  private suspendedCaptionFade:
    | SuspendedCaptionTimer
    | null = null;
  private suspendedCaptionRemoval:
    | SuspendedCaptionTimer
    | null = null;
  private pausedFadeOpacity:
    | string
    | null = null;
  private restoreCaptionOpacityOnResume =
    false;
  private drainMode = false;

  private frameId: number | null = null;
  private stableFrameCount = 0;
  private lastLayoutSnapshot:
    | LayoutSnapshot
    | null = null;
  private mutationTimerId: number | null =
    null;
  private cueAdvanceTimerId:
    | number
    | null = null;
  private captionFadeTimerId:
    | number
    | null = null;
  private captionRemovalTimerId:
    | number
    | null = null;
  private destroyed = false;

  constructor(options: CaptionOverlayOptions) {
    this.options = options;
    this.showOriginal =
      options.showOriginal;
    this.showTentative =
      options.showTentative;

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.setAttribute("popover", "manual");
    this.host.dataset.cueMutations = "0";
    this.host.dataset.cueDrops = "0";
    this.host.dataset.captionMeasure = "units";
    this.host.dataset.captionLineMeasure =
      "constant";
    this.host.style.position = "fixed";
    this.host.style.display = "block";
    this.host.style.margin = "0";
    this.host.style.inset = "auto";
    this.host.style.border = "0";
    this.host.style.padding = "0";
    this.host.style.background = "transparent";
    this.host.style.overflow = "visible";
    this.host.style.width = "auto";
    this.host.style.height = "auto";
    this.host.style.pointerEvents = "none";
    this.host.style.zIndex = "2147483647";

    const shadow =
      this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = getOverlayStyles();

    this.captionStack =
      document.createElement("div");
    this.captionStack.className =
      "caption-stack";
    this.captionStack.dataset.captionMeasure =
      "units";
    this.captionStack.dataset.captionLineMeasure =
      "constant";

    this.translationBadge =
      document.createElement("div");
    this.translationBadge.className =
      "translation-badge";
    this.translationBadge.textContent =
      "翻訳未使用";

    this.captionLine =
      document.createElement("div");
    this.captionLine.className =
      "caption-line is-empty";

    this.cueContainer =
      document.createElement("div");
    this.cueContainer.className =
      "cue-container";

    this.cueElement =
      document.createElement("div");
    this.cueElement.className =
      "caption-cue";

    this.primaryLines = [
      document.createElement("div"),
      document.createElement("div"),
    ];

    for (const line of this.primaryLines) {
      line.className = "caption-primary";
    }

    this.originalLine =
      document.createElement("div");
    this.originalLine.className =
      "caption-original";

    this.cueElement.append(
      ...this.primaryLines,
      this.originalLine,
    );
    this.cueContainer.append(
      this.cueElement,
    );
    this.cueTextSnapshots.set(
      this.cueElement,
      "",
    );

    this.captionLedger =
      document.createElement("div");
    this.captionLedger.className =
      "caption-ledger";

    this.tentativeLine =
      document.createElement("div");
    this.tentativeLine.className =
      "caption-tentative";
    this.tentativeLine.setAttribute(
      "aria-live",
      "off",
    );

    this.captionLine.append(
      this.cueContainer,
      this.tentativeLine,
    );

    this.captionStack.append(
      this.translationBadge,
      this.captionLine,
    );

    this.targetChip =
      document.createElement("div");
    this.targetChip.className =
      "chip target-chip status-loading";
    this.targetChip.title =
      options.buildStamp;
    this.targetChip.style.pointerEvents =
      "auto";

    this.targetDot =
      document.createElement("span");
    this.targetDot.className = "target-dot";
    this.targetDot.setAttribute(
      "aria-hidden",
      "true",
    );

    this.targetText =
      document.createElement("span");

    this.targetChip.append(
      this.targetDot,
      this.targetText,
    );

    this.otherLayer =
      document.createElement("div");
    this.otherLayer.className = "other-layer";

    shadow.append(
      style,
      this.captionStack,
      this.captionLedger,
      this.targetChip,
      this.otherLayer,
    );

    this.resizeObserver =
      new ResizeObserver(() => {
        this.startFrameLoop();
      });

    this.mutationObserver =
      new MutationObserver(() => {
        this.startFrameLoop();
        this.scheduleMutationPass();
      });

    this.cueMutationObserver =
      new MutationObserver(
        (mutations) => {
          this.inspectCueMutations(mutations);
        },
      );

    this.cueMutationObserver.observe(
      this.cueContainer,
      {
        childList: true,
        characterData: true,
        subtree: true,
      },
    );

    this.updateTranslationBadge();
    this.updateTargetChip();
    this.appendHost();
    this.observeMutationRoot();
    this.installEventListeners();
    this.refreshTarget();
    this.refreshOtherVideos();
    this.startFrameLoop();

    console.log("[overlay]", "overlay created", {
      showOriginal: this.showOriginal,
      showTentative: this.showTentative,
    });
  }

  showCaption(line: CaptionLine): void {
    if (this.destroyed) {
      return;
    }

    if (line.final) {
      this.receiveCommittedClause(line);
    } else {
      this.receiveTentative(line);
    }

    this.refreshTarget();
    this.updateLayout();
    this.startFrameLoop();
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.clearWatermarkId =
      maximumNullable(
        this.clearWatermarkId,
        this.highestSeenFinalId,
      );

    this.captionRevision += 1;
    this.cancelCueAdvance();
    this.cancelCaptionFade();
    this.resetCaptionFadeVisualState();
    this.pendingFinals.clear();
    this.waitingCues.splice(
      0,
      this.waitingCues.length,
    );
    this.activeCue = null;
    this.tentativeId = null;
    this.tentativeAt = null;
    this.deferredTentative = null;
    this.deferredTentativeClearThroughId =
      null;
    this.acceleratedUntilDrained = false;
    this.captionBarEnabled = false;

    this.lastAcceptedPrimary = "";
    this.lastAcceptedSource = "";
    this.lastAcceptedKind = null;
    this.drainMode = false;
    this.resetDisplayBlock();
    this.captionLedger.replaceChildren();
    this.tentativeLine.textContent = "";
    this.captionLine.classList.add(
      "is-empty",
    );
    this.captionStack.style.display = "none";

    console.log("[overlay]", "captions cleared");
  }

  setTranslationPath(
    path: TranslationPath | null,
  ): void {
    if (this.destroyed) {
      return;
    }

    this.translationPath = path;
    this.updateTranslationBadge();

    if (path === "none") {
      const pending = Array.from(
        this.pendingFinals.values(),
      ).sort(
        (left, right) =>
          left.id - right.id,
      );

      this.pendingFinals.clear();

      for (const line of pending) {
        this.acceptCommittedClause({
          ...line,
          ja: line.text,
          fallback: true,
        });
      }
    }

    this.updateCaptionVisibility();
    this.updateLayout();
  }

  setSilentInputHint(
    variant: SilentInputHintVariant | null,
  ): void {
    if (this.destroyed) {
      return;
    }

    if (this.silentInputHint === variant) {
      return;
    }

    this.silentInputHint = variant;
    this.updateTargetChip();
    this.updateLayout();
    this.startFrameLoop();
  }

  setPlaybackPaused(paused: boolean): void {
    if (
      this.destroyed ||
      this.playbackPaused === paused ||
      (paused && this.drainMode)
    ) {
      return;
    }

    if (paused) {
      this.pauseCaptionDisplay();
      return;
    }

    this.resumeCaptionDisplay();
  }

  beginDrain(): void {
    if (
      this.destroyed ||
      this.drainMode
    ) {
      return;
    }

    this.drainMode = true;

    if (this.playbackPaused) {
      this.resumeCaptionDisplay();
    }
  }

  endDrain(): void {
    this.drainMode = false;
  }

  clearPlaybackFreezeOnSeek(): void {
    if (this.destroyed) {
      return;
    }

    const soughtAt = performance.now();

    this.cancelCueAdvance();
    this.cancelCaptionFade();
    this.resetCaptionFadeVisualState();

    if (this.activeCue !== null) {
      this.activeCue.shownAt = soughtAt;
    }

    this.playbackPausedAt =
      this.playbackPaused
        ? soughtAt
        : null;

    this.tryAdvanceCue();
    this.scheduleCaptionFade();
    this.updateCaptionVisibility();
  }

  setStatus(
    state: CaptionOverlayStatus,
    progress?: number,
  ): void {
    if (this.destroyed) {
      return;
    }

    this.status = state;
    this.progress =
      progress === undefined ||
      !Number.isFinite(progress)
        ? undefined
        : Math.min(
            100,
            Math.max(0, progress),
          );

    if (
      state === "loadingModel" ||
      state === "running"
    ) {
      this.captionBarEnabled = true;
    }

    this.updateTargetChip();
    this.refreshTarget();
    this.refreshOtherVideos();
    this.updateLayout();
    this.startFrameLoop();

    console.log("[overlay]", "status changed", {
      state,
      progress: this.progress,
    });
  }

  hasPendingCaption(): boolean {
    return (
      this.hasUnrenderedActiveCuePage() ||
      this.waitingCues.length > 0 ||
      this.pendingFinals.size > 0 ||
      this.activeCue !== null ||
      this.tentativeLine.textContent !== "" ||
      this.deferredTentative !== null ||
      this.suspendedCaptionFade !== null ||
      this.suspendedCaptionRemoval !== null
    );
  }

  private hasUnrenderedActiveCuePage():
    boolean {
    return (
      this.activeCue !== null &&
      this.activeCue.pageIndex <
        this.activeCue.pages.length - 1
    );
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.notifyPageHidden();
    this.cancelCueAdvance();
    this.cancelCaptionFade();
    this.resetCaptionFadeVisualState();

    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }

    if (this.mutationTimerId !== null) {
      globalThis.clearTimeout(
        this.mutationTimerId,
      );
      this.mutationTimerId = null;
    }

    this.removeEventListeners();
    this.mutationObserver.disconnect();
    this.cueMutationObserver.disconnect();
    this.resizeObserver.disconnect();
    this.otherBadges.clear();
    this.pendingFinals.clear();
    this.waitingCues.splice(
      0,
      this.waitingCues.length,
    );
    this.deferredTentative = null;
    this.deferredTentativeClearThroughId =
      null;
    this.drainMode = false;
    this.playbackPaused = false;
    this.playbackPausedAt = null;
    this.targetVideo = null;
    this.lastLayoutSnapshot = null;
    this.hideHostPopover();
    this.host.remove();

    console.log("[overlay]", "overlay destroyed");
  }

  private pauseCaptionDisplay(): void {
    const pausedAt = performance.now();

    this.playbackPaused = true;
    this.playbackPausedAt = pausedAt;
    this.cancelCueAdvance();
    this.suspendCaptionTimers(pausedAt);
  }

  private resumeCaptionDisplay(): void {
    const resumedAt = performance.now();
    const pausedAt = this.playbackPausedAt;

    this.playbackPaused = false;
    this.playbackPausedAt = null;

    if (
      pausedAt !== null &&
      this.activeCue !== null
    ) {
      this.activeCue.shownAt +=
        Math.max(0, resumedAt - pausedAt);
    }

    if (
      this.restoreCaptionOpacityOnResume
    ) {
      this.resetCaptionFadeVisualState();
    }

    this.applyDeferredTentativeState();
    this.resumeSuspendedCaptionTimers();
    this.tryAdvanceCue();
    this.updateCaptionVisibility();
  }

  private suspendCaptionTimers(
    pausedAt: number,
  ): void {
    if (this.captionFadeTimerId !== null) {
      globalThis.clearTimeout(
        this.captionFadeTimerId,
      );
      this.captionFadeTimerId = null;

      this.suspendedCaptionFade = {
        remainingMs: Math.max(
          0,
          (
            this.captionFadeDeadline ??
            pausedAt
          ) - pausedAt,
        ),
        revision:
          this.captionFadeRevision ??
          this.captionRevision,
      };
      this.captionFadeDeadline = null;
      this.captionFadeRevision = null;
    }

    if (
      this.captionRemovalTimerId !== null
    ) {
      this.freezeCaptionFadeVisual();

      globalThis.clearTimeout(
        this.captionRemovalTimerId,
      );
      this.captionRemovalTimerId = null;

      this.suspendedCaptionRemoval = {
        remainingMs: Math.max(
          0,
          (
            this.captionRemovalDeadline ??
            pausedAt
          ) - pausedAt,
        ),
        revision:
          this.captionRemovalRevision ??
          this.captionRevision,
      };
      this.captionRemovalDeadline = null;
      this.captionRemovalRevision = null;
    }
  }

  private resumeSuspendedCaptionTimers():
    void {
    if (
      (
        this.activeCue === null &&
        this.tentativeLine.textContent === ""
      ) ||
      this.waitingCues.length > 0 ||
      this.pendingFinals.size > 0
    ) {
      this.suspendedCaptionFade = null;
      this.suspendedCaptionRemoval = null;
      return;
    }

    const suspendedRemoval =
      this.suspendedCaptionRemoval;
    const suspendedFade =
      this.suspendedCaptionFade;

    this.suspendedCaptionRemoval = null;
    this.suspendedCaptionFade = null;

    if (suspendedRemoval !== null) {
      this.armCaptionRemoval(
        suspendedRemoval.remainingMs,
        suspendedRemoval.revision,
      );
      return;
    }

    if (suspendedFade !== null) {
      this.armCaptionFade(
        suspendedFade.remainingMs,
        suspendedFade.revision,
      );
    }
  }

  private freezeCaptionFadeVisual(): void {
    if (
      !this.captionLine.classList.contains(
        "is-fading",
      )
    ) {
      return;
    }

    const opacity =
      getComputedStyle(
        this.captionLine,
      ).opacity;

    this.pausedFadeOpacity = opacity;
    this.captionLine.style.transition =
      "none";
    this.captionLine.style.opacity =
      opacity;
  }

  private resumeCaptionFadeVisual(
    remainingMs: number,
  ): void {
    if (this.pausedFadeOpacity === null) {
      return;
    }

    this.captionLine.style.setProperty(
      "--caption-fade-duration",
      `${Math.max(
        1,
        Math.ceil(remainingMs),
      )}ms`,
    );
    this.captionLine.style.transition =
      "none";
    this.captionLine.style.opacity =
      this.pausedFadeOpacity;

    void this.captionLine.offsetWidth;

    this.captionLine.style.removeProperty(
      "transition",
    );
    this.captionLine.style.removeProperty(
      "opacity",
    );
    this.pausedFadeOpacity = null;
  }

  private resetCaptionFadeVisualState():
    void {
    this.captionLine.classList.remove(
      "is-fading",
    );
    this.captionLine.style.removeProperty(
      "transition",
    );
    this.captionLine.style.removeProperty(
      "opacity",
    );
    this.captionLine.style.removeProperty(
      "--caption-fade-duration",
    );
    this.pausedFadeOpacity = null;
    this.restoreCaptionOpacityOnResume =
      false;
  }

  private applyDeferredTentativeState():
    void {
    const clearThroughId =
      this.deferredTentativeClearThroughId;
    const deferred =
      this.deferredTentative;

    this.deferredTentativeClearThroughId =
      null;
    this.deferredTentative = null;

    if (
      clearThroughId !== null &&
      this.tentativeId !== null &&
      this.tentativeId <= clearThroughId
    ) {
      this.clearTentative();
    }

    if (deferred !== null) {
      this.receiveTentative(deferred);
    }
  }

  private receiveCommittedClause(
    line: CaptionLine,
  ): void {
    const text = line.text.trim();
    const ja = line.ja?.trim() ?? "";

    if (
      text === "" ||
      this.isBehindClearWatermark(line.id) ||
      this.acceptedFinalIds.has(line.id)
    ) {
      return;
    }

    this.highestSeenFinalId =
      maximumNullable(
        this.highestSeenFinalId,
        line.id,
      );

    this.clearTentativeThrough(line.id);

    if (
      ja === "" &&
      this.translationPath !== "none"
    ) {
      const previous =
        this.pendingFinals.get(line.id);

      if (
        previous === undefined ||
        line.at >= previous.at
      ) {
        this.pendingFinals.set(
          line.id,
          {
            ...line,
            text,
            final: true,
          },
        );
      }

      this.cancelCaptionFade();
      return;
    }

    this.pendingFinals.delete(line.id);
    this.cancelCaptionFade();
    this.acceptCommittedClause({
      ...line,
      text,
      final: true,
      ...(ja === ""
        ? {
            ja: text,
            fallback: true,
          }
        : { ja }),
    });
  }

  private acceptCommittedClause(
    line: CaptionLine,
  ): void {
    if (
      this.acceptedFinalIds.has(line.id) ||
      this.isBehindClearWatermark(line.id)
    ) {
      return;
    }

    const highestAccepted =
      maximumSetValue(
        this.acceptedFinalIds,
      );

    if (
      highestAccepted !== null &&
      line.id < highestAccepted
    ) {
      return;
    }

    // The recognizer sometimes commits a clause and then commits a longer
    // revision of the same words. Replacing the cue used to hide that; an
    // append block would show the sentence twice, so only the new tail is
    // appended.
    const fullPrimary =
      this.resolvePrimaryText(line);
    const source = line.text.trim();
    const kind =
      line.fallback === true
        ? "fallback"
        : "translated";
    const isRevision =
      this.lastAcceptedSource !== "" &&
      source.startsWith(
        this.lastAcceptedSource,
      );
    let primary = fullPrimary;
    let sourceDiff = false;

    if (isRevision) {
      if (
        this.lastAcceptedKind ===
          "translated" &&
        kind === "translated"
      ) {
        if (
          this.lastAcceptedPrimary !== "" &&
          primary.startsWith(
            this.lastAcceptedPrimary,
          )
        ) {
          primary = primary
            .slice(
              this.lastAcceptedPrimary.length,
            )
            .trimStart();
        }
      } else {
        primary = source
          .slice(
            this.lastAcceptedSource.length,
          )
          .trimStart();
        sourceDiff = true;
      }
    }

    if (fullPrimary !== "") {
      this.lastAcceptedPrimary = fullPrimary;
    }

    if (source !== "") {
      this.lastAcceptedSource = source;
      this.lastAcceptedKind = kind;
    }

    const cues =
      this.createCueSegments(
        line,
        primary,
        sourceDiff,
      );

    if (cues.length === 0) {
      this.acceptedFinalIds.add(line.id);

      if (
        this.drainMode &&
        !this.hasPendingCaption()
      ) {
        this.options.onCaptionFadeOut?.();
        return;
      }

      this.scheduleCaptionFade();
      return;
    }

    this.acceptedFinalIds.add(line.id);
    this.captionBarEnabled = true;
    this.captionRevision += 1;
    this.cancelCaptionFade();

    for (const cue of cues) {
      this.appendLedgerEntry(cue.primaryText);
      this.waitingCues.push(cue);
      this.enforceQueueDiscipline();
      this.tryAdvanceCue();
    }

    this.updateCaptionVisibility();
  }

  private resolvePrimaryText(
    line: CaptionLine,
  ): string {
    const source = line.text.trim();
    const translated =
      line.ja?.trim() ?? "";

    return translated === "" &&
      this.translationPath === "none"
      ? source
      : translated;
  }

  private captionWrapLayout() {
    return {
      availableWidth: this.captionInnerWidth,
      measure: (text: string) =>
        this.textMeasurer.measure(text),
    };
  }

  private createCueSegments(
    line: CaptionLine,
    primaryOverride?: string,
    suppressOriginal = false,
  ): CueData[] {
    const source = line.text.trim();
    const translated =
      line.ja?.trim() ?? "";
    const useEnglish =
      translated === "" &&
      this.translationPath === "none";
    const primary =
      primaryOverride ??
      (useEnglish ? source : translated);

    if (primary === "") {
      return [];
    }

    const parts = splitCueText(
      primary,
      this.lineUnitBudget * 2,
      this.captionWrapLayout(),
    );
    const fallback =
      line.fallback === true ||
      useEnglish ||
      suppressOriginal;
    const original =
      this.showOriginal &&
      !suppressOriginal &&
      !fallback &&
      translated !== source
        ? clampTail(
            source,
            MAX_ORIGINAL_CHARS,
          )
        : "";

    return parts.map(
      (part, index): CueData => ({
        cueId: `${line.id}:${index}`,
        sourceIds: [line.id],
        primaryText: part,
        originalText: original,
        sourceText: source,
        fallback,
        formattedPrimary:
          wrapCueText(
            part,
            this.lineUnitBudget,
            this.captionWrapLayout(),
          ),
      }),
    );
  }

  private appendLedgerEntry(
    text: string,
  ): void {
    const entry =
      document.createElement("div");
    entry.textContent = text;
    this.captionLedger.append(entry);

    while (
      this.captionLedger.childElementCount >
      MAX_LEDGER_ENTRIES
    ) {
      this.captionLedger
        .firstElementChild
        ?.remove();
    }
  }

  private receiveTentative(
    line: CaptionLine,
  ): void {
    const text =
      (line.ja?.trim() || line.text.trim());

    if (
      text === "" ||
      this.isBehindClearWatermark(line.id) ||
      this.acceptedFinalIds.has(line.id)
    ) {
      return;
    }

    const latestTentativeId =
      this.deferredTentative?.id ??
      this.tentativeId;
    const latestTentativeAt =
      this.deferredTentative?.at ??
      this.tentativeAt;

    if (
      latestTentativeId !== null &&
      (
        line.id < latestTentativeId ||
        (
          line.id === latestTentativeId &&
          latestTentativeAt !== null &&
          line.at < latestTentativeAt
        )
      )
    ) {
      return;
    }

    if (this.playbackPaused) {
      if (
        this.deferredTentativeClearThroughId !==
          null &&
        line.id <=
          this.deferredTentativeClearThroughId
      ) {
        return;
      }

      this.deferredTentative = {
        ...line,
        final: false,
      };
      this.captionBarEnabled = true;
      this.cancelCaptionFade();
      return;
    }

    this.tentativeId = line.id;
    this.tentativeAt = line.at;
    this.tentativeLine.textContent =
      clampTail(text, 120);
    this.captionBarEnabled = true;
    this.captionRevision += 1;
    this.cancelCaptionFade();
    this.updateCaptionVisibility();
    this.scheduleCaptionFade();
  }

  private clearTentativeThrough(
    id: number,
  ): void {
    const clearsVisible =
      this.tentativeId !== null &&
      this.tentativeId <= id;
    const clearsDeferred =
      this.deferredTentative !== null &&
      this.deferredTentative.id <= id;

    if (!clearsVisible && !clearsDeferred) {
      return;
    }

    if (this.playbackPaused) {
      this.deferredTentativeClearThroughId =
        maximumNullable(
          this.deferredTentativeClearThroughId,
          id,
        );

      if (clearsDeferred) {
        this.deferredTentative = null;
      }

      return;
    }

    if (clearsVisible) {
      this.clearTentative();
    }

    if (clearsDeferred) {
      this.deferredTentative = null;
    }
  }

  private clearTentative(): void {
    this.tentativeId = null;
    this.tentativeAt = null;
    this.tentativeLine.textContent = "";
  }

  private enforceQueueDiscipline(): void {
    const decision =
      decideCueQueueDiscipline(
        this.waitingCues.map(
          (cue) => ({
            cueId: cue.cueId,
            units: displayUnits(
              cue.primaryText,
            ),
            fallback: cue.fallback,
          }),
        ),
        this.acceleratedUntilDrained,
        {
          maxWaitingCues:
            MAX_WAITING_CUES,
          maxCueUnits:
            this.lineUnitBudget * 2,
          accelerationThreshold:
            CUE_ACCELERATION_THRESHOLD,
          mergeSeparatorUnits:
            displayUnits(" "),
        },
      );

    this.acceleratedUntilDrained =
      decision.acceleratedUntilDrained;

    for (
      const index of decision.mergeIndices
    ) {
      const left =
        this.waitingCues[index];
      const right =
        this.waitingCues[index + 1];

      if (
        left === undefined ||
        right === undefined
      ) {
        continue;
      }

      const combinedPrimary =
        `${left.primaryText} ${right.primaryText}`
          .replace(/\s+/gu, " ")
          .trim();
      const combinedOriginal =
        [left.originalText, right.originalText]
          .filter(
            (value) => value !== "",
          )
          .join(" ")
          .trim();
      const combinedSource =
        left.sourceText ===
          right.sourceText
          ? left.sourceText
          : `${left.sourceText} ${right.sourceText}`
              .replace(/\s+/gu, " ")
              .trim();

      this.waitingCues.splice(
        index,
        2,
        {
          cueId:
            `${left.cueId}+${right.cueId}`,
          sourceIds: [
            ...left.sourceIds,
            ...right.sourceIds,
          ],
          primaryText: combinedPrimary,
          originalText: clampTail(
            combinedOriginal,
            MAX_ORIGINAL_CHARS,
          ),
          sourceText: combinedSource,
          fallback: left.fallback,
          formattedPrimary:
            wrapCueText(
              combinedPrimary,
              this.lineUnitBudget,
              this.captionWrapLayout(),
            ),
        },
      );
    }

    let remainingDrops =
      decision.dropCount;

    while (remainingDrops > 0) {
      const dropped =
        this.waitingCues.shift();

      if (dropped === undefined) {
        break;
      }

      remainingDrops -= 1;
      this.droppedCueCount += 1;
      this.host.dataset.cueDrops =
        String(this.droppedCueCount);
      this.droppedCuesSinceLastReport += 1;

      const now = performance.now();

      if (
        this.lastCueDropWarningAt ===
          null ||
        now - this.lastCueDropWarningAt >=
          CUE_DROP_WARNING_INTERVAL_MS
      ) {
        console.warn(
          "[overlay]",
          `dropped ${
            this.droppedCuesSinceLastReport
          } waiting cues since last report`,
          {
            droppedCueCount:
              this.droppedCueCount,
          },
        );

        this.droppedCuesSinceLastReport = 0;
        this.lastCueDropWarningAt = now;
      }
    }

    if (decision.shouldReschedule) {
      this.rescheduleCueAdvance();
    }
  }

  private tryAdvanceCue(
    fromDwellTimer = false,
  ): void {
    if (
      this.destroyed ||
      this.playbackPaused
    ) {
      return;
    }

    if (this.activeCue === null) {
      const next = this.waitingCues.shift();

      if (next !== undefined) {
        this.displayCue(next);
      }

      return;
    }

    const hasUnrenderedPage =
      this.hasUnrenderedActiveCuePage();

    if (
      !hasUnrenderedPage &&
      this.waitingCues.length === 0
    ) {
      this.acceleratedUntilDrained =
        retainAccelerationUntilDrained(
          this.acceleratedUntilDrained,
          this.waitingCues.length,
        );
      this.cancelCueAdvance();
      this.scheduleCaptionFade();
      return;
    }

    const displayDurationMs =
      cueDisplayDurationMs(
        this.acceleratedUntilDrained,
        CUE_MINIMUM_DISPLAY_MS,
        CUE_ACCELERATED_DISPLAY_MS,
      );
    const elapsed =
      performance.now() -
      this.activeCue.shownAt;
    const remaining =
      displayDurationMs - elapsed;

    if (
      !fromDwellTimer ||
      remaining > 0
    ) {
      if (this.cueAdvanceTimerId === null) {
        const delayMs =
          Math.max(0, remaining);

        this.cueAdvanceTimerId =
          window.setTimeout(() => {
            this.cueAdvanceTimerId = null;
            this.tryAdvanceCue(true);
          }, Math.ceil(delayMs));
      }
      return;
    }

    if (hasUnrenderedPage) {
      this.displayActiveCuePage(
        this.activeCue.pageIndex + 1,
      );
      this.tryAdvanceCue();
      return;
    }

    const next = this.waitingCues.shift();

    if (next !== undefined) {
      this.displayCue(next);
    }
  }

  private displayCue(
    cue: CueData,
  ): void {
    this.cancelCueAdvance();
    this.cancelCaptionFade();

    const pages = this.paginateCue(cue);

    this.cueElement.dataset.cueId =
      cue.cueId;
    this.cueElement.dataset.primaryText =
      cue.primaryText;
    this.activeCue = {
      data: cue,
      pages,
      pageIndex: 0,
      shownAt: performance.now(),
    };

    this.displayActiveCuePage(0);
    this.captionLine.classList.remove(
      "is-empty",
      "is-fading",
    );
    this.updateCaptionVisibility();
    this.tryAdvanceCue();
  }

  private paginateCue(
    cue: CueData,
  ): readonly CaptionPage[] {
    // Wrap against the box as it is now, not as it was when the cue was
    // queued. Leaving fullscreen narrows the caption slots, and a cue that
    // waited through that would arrive wrapped for a box that no longer
    // exists; .caption-primary hides overflow, so it would be cut.
    const lines = wrapCueText(
      cue.primaryText,
      this.lineUnitBudget,
      this.captionWrapLayout(),
    ).split("\n");
    const pages: CaptionPage[] = [];

    for (
      let index = 0;
      index < lines.length;
      index += 2
    ) {
      pages.push([
        lines[index] ?? "",
        lines[index + 1] ?? "",
      ]);
    }

    return pages;
  }

  private displayActiveCuePage(
    pageIndex: number,
  ): void {
    const activeCue = this.activeCue;
    const page =
      activeCue?.pages[pageIndex];

    if (
      activeCue === null ||
      activeCue === undefined ||
      page === undefined
    ) {
      return;
    }

    const [
      firstLine,
      secondLine,
    ] = page;
    const originalText =
      activeCue.data.originalText;
    const expectedText =
      firstLine +
      secondLine +
      originalText;

    this.cueTextSnapshots.set(
      this.cueElement,
      expectedText,
    );
    activeCue.pageIndex = pageIndex;
    activeCue.shownAt = performance.now();
    this.cueElement.dataset.pageId =
      String(pageIndex);
    this.primaryLines[0].textContent =
      firstLine;
    this.primaryLines[1].textContent =
      secondLine;
    this.originalLine.textContent =
      originalText;
    this.notifyDisplayedPage(
      activeCue,
      pageIndex,
      firstLine,
      secondLine,
      originalText,
    );
  }

  private notifyDisplayedPage(
    activeCue: ActiveCue,
    pageIndex: number,
    firstLine: string,
    secondLine: string,
    originalText: string,
  ): void {
    this.shownPage = {
      activeCue,
      pageIndex,
      firstLine,
      secondLine,
      originalText,
    };

    this.options.displayLog?.recordPageShown(
      {
        cueId: activeCue.data.cueId,
        pageId: String(pageIndex),
        line0: firstLine,
        line1: secondLine,
        sourceText:
          activeCue.data.sourceText,
        translationPath:
          this.translationPath,
        showOriginal: this.showOriginal,
        showTentative:
          this.showTentative,
        originalRowVisible:
          this.showOriginal &&
          originalText !== "",
        tentativeRowVisible:
          this.showTentative &&
          this.tentativeLine.textContent !==
            "",
      },
    );
  }

  private notifyPageHidden(): void {
    this.options.displayLog
      ?.recordPageHidden();
    this.shownPage = null;
  }

  /**
   * Tracks whether the caption stack is on screen, closing the logged page when
   * it goes and opening it again when it returns.
   *
   * The stack is hidden whenever the captured video scrolls out of view, which
   * is ordinary on a feed. Without this the logged dwell spans the scroll.
   */
  private setCaptionStackVisible(
    visible: boolean,
  ): void {
    if (visible === this.captionStackVisible) {
      return;
    }

    this.captionStackVisible = visible;

    if (!visible) {
      const page = this.shownPage;
      this.options.displayLog
        ?.recordPageHidden();
      this.shownPage = page;
      return;
    }

    const page = this.shownPage;

    if (page !== null) {
      this.notifyDisplayedPage(
        page.activeCue,
        page.pageIndex,
        page.firstLine,
        page.secondLine,
        page.originalText,
      );
    }
  }

  private resetDisplayBlock(): void {
    this.notifyPageHidden();
    this.cueTextSnapshots.set(
      this.cueElement,
      "",
    );
    this.primaryLines[0].textContent = "";
    this.primaryLines[1].textContent = "";
    this.originalLine.textContent = "";
    delete this.cueElement.dataset.cueId;
    delete this.cueElement.dataset.pageId;
    delete this.cueElement.dataset
      .primaryText;
  }

  private inspectCueMutations(
    mutations: readonly MutationRecord[],
  ): void {
    const changed =
      new Set<Element>();

    for (const mutation of mutations) {
      let element: Element | null = null;

      if (
        mutation.target instanceof Element
      ) {
        element =
          mutation.target.closest(
            ".caption-cue",
          );
      } else {
        element =
          mutation.target.parentElement
            ?.closest(".caption-cue") ??
          null;
      }

      if (
        element !== null &&
        this.cueTextSnapshots.has(element)
      ) {
        changed.add(element);
      }
    }

    for (const element of changed) {
      const previous =
        this.cueTextSnapshots.get(element);
      const current =
        element.textContent ?? "";

      if (
        previous === undefined ||
        previous === current
      ) {
        continue;
      }

      this.cueTextSnapshots.set(
        element,
        current,
      );
      this.cueMutationCount += 1;
      this.host.dataset.cueMutations =
        String(this.cueMutationCount);

      console.error(
        "[overlay]",
        "existing cue text mutated in place",
        {
          cueId:
            (
              element as HTMLElement
            ).dataset.cueId,
          cueMutationCount:
            this.cueMutationCount,
        },
      );
    }
  }

  private isBehindClearWatermark(
    id: number,
  ): boolean {
    return (
      this.clearWatermarkId !== null &&
      id <= this.clearWatermarkId
    );
  }

  private rescheduleCueAdvance(): void {
    this.cancelCueAdvance();
    this.tryAdvanceCue();
  }

  private cancelCueAdvance(): void {
    if (this.cueAdvanceTimerId !== null) {
      globalThis.clearTimeout(
        this.cueAdvanceTimerId,
      );
      this.cueAdvanceTimerId = null;
    }
  }

  private updateCaptionVisibility(): void {
    const visible =
      this.primaryLines[0].textContent !==
        "" ||
      this.primaryLines[1].textContent !==
        "" ||
      this.tentativeLine.textContent !== "";

    this.captionLine.classList.toggle(
      "is-empty",
      !visible,
    );
    // The bar paints its own background, and the layout pass shows it whenever
    // capture is on and the target is visible. Without this the viewer keeps a
    // black box over the video through every gap between captions.
    this.captionStack.classList.toggle(
      "is-blank",
      !visible,
    );

    if (
      !visible &&
      !this.playbackPaused
    ) {
      this.resetCaptionFadeVisualState();
    }

    this.startFrameLoop();
  }

  private installEventListeners(): void {
    window.addEventListener(
      "scroll",
      this.handleViewportChange,
      {
        capture: true,
        passive: true,
      },
    );
    window.addEventListener(
      "resize",
      this.handleViewportChange,
      {
        capture: true,
        passive: true,
      },
    );
    document.addEventListener(
      "fullscreenchange",
      this.handleFullscreenChange,
    );
    document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private removeEventListeners(): void {
    window.removeEventListener(
      "scroll",
      this.handleViewportChange,
      true,
    );
    window.removeEventListener(
      "resize",
      this.handleViewportChange,
      true,
    );
    document.removeEventListener(
      "fullscreenchange",
      this.handleFullscreenChange,
    );
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private readonly handleViewportChange =
    (): void => {
      this.startFrameLoop();
      this.scheduleMutationPass();
    };

  private readonly handleFullscreenChange =
    (): void => {
      this.appendHost();
      this.refreshTarget();
      this.refreshOtherVideos();
      this.updateLayout();
      this.startFrameLoop();
    };

  private readonly handleVisibilityChange =
    (): void => {
      if (
        document.visibilityState ===
        "visible"
      ) {
        this.appendHost();
        this.refreshTarget();
        this.refreshOtherVideos();
        this.startFrameLoop();
        return;
      }

      if (this.frameId !== null) {
        cancelAnimationFrame(this.frameId);
        this.frameId = null;
      }

      this.stableFrameCount = 0;
    };

  private readonly runFrame =
    (): void => {
      this.frameId = null;

      if (
        this.destroyed ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      this.refreshTarget();

      const snapshot =
        this.captureLayoutSnapshot();
      const isStable =
        this.lastLayoutSnapshot !== null &&
        layoutSnapshotsEqual(
          this.lastLayoutSnapshot,
          snapshot,
        );

      if (isStable) {
        this.stableFrameCount += 1;
      } else {
        this.stableFrameCount = 0;
        this.updateLayout(snapshot);
      }

      if (
        this.stableFrameCount >=
        STABLE_FRAMES_BEFORE_IDLE
      ) {
        return;
      }

      this.frameId =
        requestAnimationFrame(this.runFrame);
    };

  private startFrameLoop(): void {
    if (
      this.destroyed ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    this.stableFrameCount = 0;

    if (this.frameId !== null) {
      return;
    }

    this.frameId =
      requestAnimationFrame(this.runFrame);
  }

  private appendHost(): void {
    if (this.destroyed) {
      return;
    }

    const fallbackParent =
      document.body ??
      document.documentElement;
    const fullscreenElement =
      document.fullscreenElement;
    const useTopLayer =
      fullscreenElement !== null &&
      isNonHostingFullscreenElement(
        fullscreenElement,
      );

    if (useTopLayer) {
      if (
        this.host.parentNode !==
        fallbackParent
      ) {
        this.hideHostPopover();
        fallbackParent.append(this.host);
        this.lastLayoutSnapshot = null;
        this.stableFrameCount = 0;
      }

      this.showHostPopover();
      return;
    }

    this.hideHostPopover();

    const parent =
      fullscreenElement ?? fallbackParent;

    if (this.host.parentNode !== parent) {
      parent.append(this.host);
      this.lastLayoutSnapshot = null;
      this.stableFrameCount = 0;
    }
  }

  private showHostPopover(): void {
    if (this.isHostPopoverOpen()) {
      return;
    }

    try {
      this.host.showPopover();
    } catch {
    }
  }

  private hideHostPopover(): void {
    if (!this.isHostPopoverOpen()) {
      return;
    }

    try {
      this.host.hidePopover();
    } catch {
    }
  }

  private isHostPopoverOpen(): boolean {
    try {
      return this.host.matches(
        ":popover-open",
      );
    } catch {
      return false;
    }
  }

  private observeMutationRoot(): void {
    const nextRoot =
      document.body ??
      document.documentElement;

    if (this.mutationRoot === nextRoot) {
      return;
    }

    this.mutationObserver.disconnect();
    this.mutationRoot = nextRoot;
    this.mutationObserver.observe(nextRoot, {
      childList: true,
      subtree: true,
    });
  }

  private scheduleMutationPass(): void {
    if (
      this.destroyed ||
      this.mutationTimerId !== null
    ) {
      return;
    }

    this.mutationTimerId =
      window.setTimeout(() => {
        this.mutationTimerId = null;
        this.runMutationPass();
      }, MUTATION_DEBOUNCE_MS);
  }

  private runMutationPass(): void {
    if (this.destroyed) {
      return;
    }

    this.observeMutationRoot();
    this.appendHost();
    this.refreshTarget();
    this.refreshOtherVideos();
    this.updateLayout();
    this.startFrameLoop();
  }

  private refreshTarget(): void {
    const reported =
      this.options.getTargetVideo();
    const nextTarget =
      reported?.isConnected === true
        ? reported
        : null;

    if (
      nextTarget === null &&
      this.status === "error" &&
      this.targetVideo?.isConnected === true
    ) {
      return;
    }

    if (nextTarget === this.targetVideo) {
      return;
    }

    if (this.playbackPaused) {
      this.setPlaybackPaused(false);
    }

    const previous = this.targetVideo;

    if (previous !== null) {
      this.resizeObserver.unobserve(previous);
    }

    this.targetVideo = nextTarget;
    this.lastLayoutSnapshot = null;

    if (nextTarget !== null) {
      this.resizeObserver.observe(nextTarget);
    }

    this.refreshOtherVideos();

    console.log("[overlay]", "target changed", {
      available: nextTarget !== null,
    });
  }

  private refreshOtherVideos(): void {
    const target = this.targetVideo;
    const captureIsOn =
      this.status === "loadingModel" ||
      this.status === "running";

    const desired =
      new Set<HTMLVideoElement>();

    if (captureIsOn && target !== null) {
      const candidates = Array.from(
        document.querySelectorAll<HTMLVideoElement>(
          "video",
        ),
      )
        .filter(
          (video) =>
            video !== target &&
            !video.muted &&
            isVideoVisible(video),
        )
        .map((video) => ({
          video,
          area: getViewportIntersectionArea(
            video.getBoundingClientRect(),
          ),
        }))
        .sort(
          (left, right) =>
            right.area - left.area,
        )
        .slice(0, MAX_OTHER_VIDEOS);

      for (const candidate of candidates) {
        desired.add(candidate.video);
      }
    }

    let changed = false;

    for (
      const [video, badge]
      of this.otherBadges
    ) {
      if (desired.has(video)) {
        continue;
      }

      this.resizeObserver.unobserve(video);
      badge.remove();
      this.otherBadges.delete(video);
      changed = true;
    }

    for (const video of desired) {
      if (this.otherBadges.has(video)) {
        continue;
      }

      const badge =
        document.createElement("div");
      badge.className = "chip other-chip";
      badge.textContent = "対象外";
      this.otherLayer.append(badge);
      this.otherBadges.set(video, badge);
      this.resizeObserver.observe(video);
      changed = true;
    }

    if (changed) {
      this.lastLayoutSnapshot = null;
    }
  }

  private updateTargetChip(): void {
    this.targetChip.className =
      "chip target-chip";

    switch (this.status) {
      case "loadingModel": {
        this.targetChip.classList.add(
          "status-loading",
        );

        if (
          this.progress !== undefined &&
          this.progress >=
            INITIALIZATION_PROGRESS_CEILING
        ) {
          this.targetText.textContent =
            "字幕 準備中(ウォームアップ)…";
          return;
        }

        const percent =
          this.progress === undefined
            ? ""
            : ` ${Math.round(this.progress)}%`;

        this.targetText.textContent =
          `字幕 準備中…${percent}`;
        return;
      }

      case "running":
        if (this.silentInputHint !== null) {
          this.targetChip.classList.add(
            "status-silent",
          );

          switch (this.silentInputHint) {
            case "paused":
              this.targetText.textContent =
                "▶ 音声がありません — 動画を再生してください";
              return;

            case "gesture":
              this.targetText.textContent =
                "▶ 音声を取得できません — ページ内を一度クリックしてください";
              return;

            case "unknown":
              this.targetText.textContent =
                "▶ 音声がありません — タブを開き直すと直ることがあります";
              return;
          }
        }

        this.targetChip.classList.add(
          "status-running",
        );
        this.targetText.textContent =
          "字幕ON";
        return;

      case "error":
        this.targetChip.classList.add(
          "status-error",
        );
        this.targetText.textContent =
          "字幕エラー";
    }
  }

  private updateTranslationBadge(): void {
    this.translationBadge.classList.toggle(
      "is-visible",
      this.translationPath === "none",
    );
  }

  private captureLayoutSnapshot(): LayoutSnapshot {
    const target = this.targetVideo;
    const targetRect =
      target === null
        ? null
        : snapshotRect(
            target.getBoundingClientRect(),
          );
    const otherVideos =
      Array.from(
        this.otherBadges.keys(),
        (video): OtherVideoLayout => ({
          video,
          rect:
            video === target ||
            video.muted ||
            !video.isConnected
              ? null
              : snapshotRect(
                  video.getBoundingClientRect(),
                ),
        }),
      );

    return {
      target,
      targetRect,
      otherVideos,
    };
  }

  private updateLayout(
    snapshot: LayoutSnapshot =
      this.captureLayoutSnapshot(),
  ): void {
    if (this.destroyed) {
      return;
    }

    this.lastLayoutSnapshot = snapshot;

    if (
      snapshot.target === null ||
      snapshot.targetRect === null
    ) {
      this.captionStack.style.display =
        "none";
      this.targetChip.style.display =
        "none";
      this.setCaptionStackVisible(false);
      this.hideOtherBadges();
      return;
    }

    const rect = snapshot.targetRect;
    const targetVisible =
      isRectVisible(rect);

    if (!targetVisible) {
      this.captionStack.style.display =
        "none";
      this.targetChip.style.display =
        "none";
      this.setCaptionStackVisible(false);
    } else {
      this.positionCaptionStack(rect);
      this.positionTargetChip(rect);
      this.setCaptionStackVisible(true);
    }

    this.positionOtherBadges(
      snapshot.otherVideos,
    );
  }

  private positionCaptionStack(
    rect: RectSnapshot,
  ): void {
    const captureIsOn =
      this.status === "loadingModel" ||
      this.status === "running";

    if (
      !captureIsOn ||
      !this.captionBarEnabled
    ) {
      this.captionStack.style.display =
        "none";
      return;
    }

    const width = Math.max(0, rect.width);
    const tentativeEnabled =
      this.showTentative;
    const barHeight =
      this.showOriginal
        ? Math.max(
            76,
            Math.min(
              tentativeEnabled ? 124 : 108,
              rect.height *
                (tentativeEnabled ? 0.29 : 0.25),
            ),
          )
        : Math.max(
            56,
            Math.min(
              tentativeEnabled ? 104 : 90,
              rect.height *
                (tentativeEnabled ? 0.23 : 0.19),
            ),
          );
    const bottomOffset = Math.max(
      44,
      Math.min(
        64,
        rect.height * 0.12,
      ),
    );

    if (width <= 0 || barHeight <= 0) {
      this.captionStack.style.display =
        "none";
      return;
    }

    const horizontalPadding = Math.max(
      10,
      Math.min(24, rect.width * 0.025),
    );
    const verticalPadding = Math.max(
      5,
      Math.min(10, barHeight * 0.08),
    );
    const availableHeight = Math.max(
      1,
      barHeight - verticalPadding * 2,
    );
    const originalRowUnits = this.showOriginal
      ? ORIGINAL_FONT_SCALE *
        ORIGINAL_LINE_HEIGHT
      : 0;
    const tentativeRowUnits =
      tentativeEnabled
        ? TENTATIVE_FONT_SCALE *
          TENTATIVE_LINE_HEIGHT
        : 0;
    const widthScaledFontSize = Math.max(
      14,
      Math.min(24, rect.width / 32),
    );
    const fontSizeFor = (
      primaryLineRatio: number,
    ): number => {
      const rowHeightUnits =
        primaryLineRatio * 2 +
        originalRowUnits +
        tentativeRowUnits;
      return Math.max(
        10,
        Math.min(
          widthScaledFontSize,
          availableHeight / rowHeightUnits,
        ),
      );
    };
    let fontSize = fontSizeFor(
      PRIMARY_LINE_HEIGHT,
    );
    const innerWidth = Math.max(
      0,
      width - horizontalPadding * 2,
    );
    this.captionInnerWidth = innerWidth;

    this.captionStack.style.display =
      "flex";
    this.captionStack.style.left =
      `${rect.left}px`;
    this.captionStack.style.bottom =
      `${
        window.innerHeight -
        rect.bottom +
        bottomOffset
      }px`;
    this.captionStack.style.width =
      `${width}px`;
    this.captionStack.style.maxWidth =
      `${width}px`;
    this.captionStack.style.height =
      `${barHeight}px`;
    this.captionStack.style.fontSize =
      `${fontSize}px`;
    this.captionStack.style.setProperty(
      "--bar-padding-x",
      `${horizontalPadding}px`,
    );
    this.captionStack.style.setProperty(
      "--bar-padding-y",
      `${verticalPadding}px`,
    );
    const computedFont = getComputedStyle(
      this.primaryLines[0],
    ).font;
    this.textMeasurer.setFont(
      computedFont.trim() === ""
        ? `${CAPTION_PRIMARY_FONT_WEIGHT} ${fontSize}px ${CAPTION_PRIMARY_FONT_FAMILY}`
        : computedFont,
    );

    const lineBox =
      this.textMeasurer.measureLineBox();
    let primaryLineSlot =
      fontSize * PRIMARY_LINE_HEIGHT;
    let lineMeasurePath:
      | "font"
      | "constant" = "constant";

    if (lineBox !== null && fontSize > 0) {
      const primaryLineRatio =
        lineBox / fontSize;
      const fittedFontSize = fontSizeFor(
        primaryLineRatio,
      );

      if (fittedFontSize !== fontSize) {
        fontSize = fittedFontSize;
        this.captionStack.style.fontSize =
          `${fontSize}px`;
        const fittedFont = getComputedStyle(
          this.primaryLines[0],
        ).font;
        this.textMeasurer.setFont(
          fittedFont.trim() === ""
            ? `${CAPTION_PRIMARY_FONT_WEIGHT} ${fontSize}px ${CAPTION_PRIMARY_FONT_FAMILY}`
            : fittedFont,
        );
      }

      const measuredSlot =
        this.textMeasurer.measureLineBox();
      primaryLineSlot = Math.ceil(
        measuredSlot ??
          primaryLineRatio * fontSize,
      );
      lineMeasurePath = "font";
    }

    this.lineUnitBudget =
      deriveLineUnitBudget(
        innerWidth,
        fontSize,
      );

    this.captionStack.style.setProperty(
      "--primary-line-slot",
      `${primaryLineSlot}px`,
    );
    this.captionStack.style.setProperty(
      "--primary-slot",
      `${primaryLineSlot * 2}px`,
    );
    this.captionStack.style.setProperty(
      "--original-slot",
      `${
        this.showOriginal
          ? fontSize *
            ORIGINAL_FONT_SCALE *
            ORIGINAL_LINE_HEIGHT
          : 0
      }px`,
    );
    this.captionStack.style.setProperty(
      "--tentative-slot",
      `${
        tentativeEnabled
          ? fontSize *
            TENTATIVE_FONT_SCALE *
            TENTATIVE_LINE_HEIGHT
          : 0
      }px`,
    );

    const measurePath =
      this.textMeasurer.isMeasured()
        ? "canvas"
        : "units";

    if (
      measurePath === "canvas" &&
      this.host.dataset.captionMeasure !==
        "canvas"
    ) {
      console.log(
        "[overlay]",
        "caption measure",
        {
          path: "canvas",
          fontSize,
          innerWidth,
        },
      );
    }

    if (
      lineMeasurePath === "font" &&
      this.host.dataset.captionLineMeasure !==
        "font"
    ) {
      console.log(
        "[overlay]",
        "caption line measure",
        {
          path: "font",
          fontSize,
          lineSlot: primaryLineSlot,
        },
      );
    }

    this.host.dataset.captionMeasure =
      measurePath;
    this.captionStack.dataset.captionMeasure =
      measurePath;
    this.host.dataset.captionLineMeasure =
      lineMeasurePath;
    this.captionStack.dataset.captionLineMeasure =
      lineMeasurePath;
  }

  private positionTargetChip(
    rect: RectSnapshot,
  ): void {
    const inset = Math.max(
      6,
      Math.min(14, rect.width * 0.018),
    );

    this.targetChip.style.display =
      "inline-flex";
    this.targetChip.style.left =
      `${rect.right - inset}px`;
    this.targetChip.style.top =
      `${rect.top + inset}px`;
  }

  private positionOtherBadges(
    layouts: readonly OtherVideoLayout[],
  ): void {
    const captureIsOn =
      this.status === "loadingModel" ||
      this.status === "running";

    if (!captureIsOn) {
      this.hideOtherBadges();
      return;
    }

    for (const layout of layouts) {
      const badge =
        this.otherBadges.get(layout.video);

      if (badge === undefined) {
        continue;
      }

      const rect = layout.rect;

      if (
        rect === null ||
        !isRectVisible(rect)
      ) {
        badge.style.display = "none";
        continue;
      }

      const inset = Math.max(
        5,
        Math.min(10, rect.width * 0.015),
      );

      badge.style.display = "inline-flex";
      badge.style.left =
        `${rect.right - inset}px`;
      badge.style.top =
        `${rect.top + inset}px`;
    }
  }

  private hideOtherBadges(): void {
    for (
      const badge
      of this.otherBadges.values()
    ) {
      badge.style.display = "none";
    }
  }

  private scheduleCaptionFade(): void {
    if (
      this.destroyed ||
      (
        this.activeCue === null &&
        this.tentativeLine.textContent === ""
      ) ||
      this.waitingCues.length > 0 ||
      this.pendingFinals.size > 0 ||
      this.hasUnrenderedActiveCuePage() ||
      this.captionFadeTimerId !== null ||
      this.captionRemovalTimerId !== null ||
      this.suspendedCaptionFade !== null ||
      this.suspendedCaptionRemoval !== null
    ) {
      return;
    }

    this.armCaptionFade(
      CAPTION_VISIBLE_MS,
      this.captionRevision,
    );
  }

  private armCaptionFade(
    delayMs: number,
    expiringRevision: number,
  ): void {
    const normalizedDelay =
      Math.max(0, delayMs);

    if (this.playbackPaused) {
      this.suspendedCaptionFade = {
        remainingMs: normalizedDelay,
        revision: expiringRevision,
      };
      return;
    }

    this.captionFadeRevision =
      expiringRevision;
    this.captionFadeDeadline =
      performance.now() + normalizedDelay;

    this.captionFadeTimerId =
      window.setTimeout(() => {
        this.captionFadeTimerId = null;
        this.captionFadeDeadline = null;
        this.captionFadeRevision = null;

        if (
          this.captionRevision !==
            expiringRevision ||
          this.waitingCues.length > 0 ||
          this.pendingFinals.size > 0 ||
          this.hasUnrenderedActiveCuePage()
        ) {
          return;
        }

        this.captionLine.classList.add(
          "is-fading",
        );

        this.armCaptionRemoval(
          CAPTION_FADE_MS,
          expiringRevision,
        );
      }, Math.ceil(normalizedDelay));
  }

  private armCaptionRemoval(
    delayMs: number,
    expiringRevision: number,
  ): void {
    const normalizedDelay =
      Math.max(0, delayMs);

    if (this.playbackPaused) {
      this.suspendedCaptionRemoval = {
        remainingMs: normalizedDelay,
        revision: expiringRevision,
      };
      return;
    }

    this.resumeCaptionFadeVisual(
      normalizedDelay,
    );
    this.captionRemovalRevision =
      expiringRevision;
    this.captionRemovalDeadline =
      performance.now() + normalizedDelay;

    this.captionRemovalTimerId =
      window.setTimeout(() => {
        this.captionRemovalTimerId = null;
        this.captionRemovalDeadline = null;
        this.captionRemovalRevision = null;

        if (
          this.captionRevision !==
            expiringRevision ||
          this.waitingCues.length > 0 ||
          this.pendingFinals.size > 0 ||
          this.hasUnrenderedActiveCuePage()
        ) {
          return;
        }

        this.activeCue = null;
        this.clearTentative();
        this.resetDisplayBlock();
        this.resetCaptionFadeVisualState();
        this.captionLine.classList.add(
          "is-empty",
        );
        this.updateCaptionVisibility();
        this.updateLayout();
        this.options.onCaptionFadeOut?.();
      }, Math.ceil(normalizedDelay));
  }

  private cancelCaptionFade(): void {
    if (this.captionFadeTimerId !== null) {
      globalThis.clearTimeout(
        this.captionFadeTimerId,
      );
      this.captionFadeTimerId = null;
    }

    if (
      this.captionRemovalTimerId !== null
    ) {
      globalThis.clearTimeout(
        this.captionRemovalTimerId,
      );
      this.captionRemovalTimerId = null;
    }

    this.captionFadeDeadline = null;
    this.captionRemovalDeadline = null;
    this.captionFadeRevision = null;
    this.captionRemovalRevision = null;
    this.suspendedCaptionFade = null;
    this.suspendedCaptionRemoval = null;

    if (
      this.playbackPaused &&
      (
        this.captionLine.classList.contains(
          "is-fading",
        ) ||
        this.pausedFadeOpacity !== null
      )
    ) {
      this.restoreCaptionOpacityOnResume =
        true;
      return;
    }

    this.resetCaptionFadeVisualState();
  }
}



function clampTail(
  text: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  return (
    "…" +
    text.slice(text.length - maxChars)
  );
}

function maximumNullable(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return Math.max(left, right);
}

function maximumSetValue(
  values: ReadonlySet<number>,
): number | null {
  let maximum: number | null = null;

  for (const value of values) {
    maximum =
      maximum === null
        ? value
        : Math.max(maximum, value);
  }

  return maximum;
}

function snapshotRect(
  rect: DOMRect,
): RectSnapshot {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function layoutSnapshotsEqual(
  left: LayoutSnapshot,
  right: LayoutSnapshot,
): boolean {
  if (
    left.target !== right.target ||
    !rectSnapshotsEqual(
      left.targetRect,
      right.targetRect,
    ) ||
    left.otherVideos.length !==
      right.otherVideos.length
  ) {
    return false;
  }

  for (
    let index = 0;
    index < left.otherVideos.length;
    index += 1
  ) {
    const leftLayout =
      left.otherVideos[index];
    const rightLayout =
      right.otherVideos[index];

    if (
      leftLayout === undefined ||
      rightLayout === undefined ||
      leftLayout.video !==
        rightLayout.video ||
      !rectSnapshotsEqual(
        leftLayout.rect,
        rightLayout.rect,
      )
    ) {
      return false;
    }
  }

  return true;
}

function rectSnapshotsEqual(
  left: RectSnapshot | null,
  right: RectSnapshot | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return (
    approximatelyEqual(
      left.left,
      right.left,
    ) &&
    approximatelyEqual(
      left.top,
      right.top,
    ) &&
    approximatelyEqual(
      left.right,
      right.right,
    ) &&
    approximatelyEqual(
      left.bottom,
      right.bottom,
    ) &&
    approximatelyEqual(
      left.width,
      right.width,
    ) &&
    approximatelyEqual(
      left.height,
      right.height,
    )
  );
}

function approximatelyEqual(
  left: number,
  right: number,
): boolean {
  return (
    Math.abs(left - right) <=
    RECT_COMPARISON_EPSILON_PX
  );
}

function isNonHostingFullscreenElement(
  element: Element,
): boolean {
  if (!(element instanceof HTMLElement)) {
    return true;
  }

  return (
    element instanceof HTMLMediaElement ||
    element instanceof HTMLImageElement ||
    element instanceof HTMLCanvasElement ||
    element instanceof HTMLIFrameElement ||
    element instanceof HTMLEmbedElement ||
    element instanceof HTMLObjectElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

function isVideoVisible(
  video: HTMLVideoElement,
): boolean {
  if (!video.isConnected) {
    return false;
  }

  const style = getComputedStyle(video);

  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }

  return isRectVisible(
    video.getBoundingClientRect(),
  );
}

function isRectVisible(
  rect: RectSnapshot | DOMRect,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function getViewportIntersectionArea(
  rect: DOMRect,
): number {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(
    window.innerWidth,
    rect.right,
  );
  const bottom = Math.min(
    window.innerHeight,
    rect.bottom,
  );

  return (
    Math.max(0, right - left) *
    Math.max(0, bottom - top)
  );
}

function getOverlayStyles(): string {
  return `
    :host,
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    :host {
      color-scheme: light;
      pointer-events: none !important;
    }

    .caption-stack {
      --bar-padding-x: 12px;
      --bar-padding-y: 6px;
      --primary-line-slot: 24px;
      --primary-slot: 48px;
      --original-slot: 0px;
      --tentative-slot: 0px;

      position: fixed;
      display: none;
      flex-direction: column;
      align-items: stretch;
      justify-content: center;
      margin: 0;
      padding:
        var(--bar-padding-y)
        var(--bar-padding-x);
      overflow: hidden;
      border-radius: 8px;
      color: #ffffff;
      background: rgba(0, 0, 0, 0.92);
      font-family: ${CAPTION_PRIMARY_FONT_FAMILY};
      text-align: center;
      pointer-events: none;
    }

    .caption-line {
      display: flex;
      flex: 0 0 auto;
      flex-direction: column;
      width: 100%;
      min-width: 0;
      height: calc(
        var(--primary-slot) +
        var(--original-slot) +
        var(--tentative-slot)
      );
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: #ffffff;
      pointer-events: none;
      opacity: 1;
      transition:
        opacity
        var(
          --caption-fade-duration,
          ${CAPTION_FADE_MS}ms
        )
        ease;
    }

    .caption-line.is-empty,
    .caption-line.is-fading {
      opacity: 0;
    }

    .caption-stack.is-blank {
      background: transparent;
      transition:
        background-color
        var(
          --caption-fade-duration,
          ${CAPTION_FADE_MS}ms
        )
        ease;
    }

    .cue-container {
      display: block;
      flex: 0 0 calc(
        var(--primary-slot) +
        var(--original-slot)
      );
      width: 100%;
      min-width: 0;
      height: calc(
        var(--primary-slot) +
        var(--original-slot)
      );
      overflow: hidden;
    }

    .caption-cue {
      display: flex;
      flex-direction: column;
      width: 100%;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.95),
        0 0 3px rgba(0, 0, 0, 0.8);
    }

    .caption-primary {
      display: block;
      flex: 0 0 var(--primary-line-slot);
      width: 100%;
      min-width: 0;
      height: var(--primary-line-slot);
      min-height: var(--primary-line-slot);
      max-height: var(--primary-line-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      overflow-wrap: normal;
      font-size: 1em;
      font-style: normal;
      font-weight: ${CAPTION_PRIMARY_FONT_WEIGHT};
      line-height: var(--primary-line-slot);
      white-space: pre-line;
    }

    .caption-original {
      display: block;
      flex: 0 0 var(--original-slot);
      width: 100%;
      min-width: 0;
      height: var(--original-slot);
      min-height: var(--original-slot);
      max-height: var(--original-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: rgba(229, 231, 235, 0.78);
      font-size: ${ORIGINAL_FONT_SCALE}em;
      font-style: normal;
      font-weight: 500;
      line-height: ${ORIGINAL_LINE_HEIGHT};
      text-overflow: ellipsis;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.9);
      white-space: nowrap;
    }

    .caption-ledger {
      display: none;
    }

    .caption-tentative {
      display: block;
      flex: 0 0 var(--tentative-slot);
      width: 100%;
      min-width: 0;
      height: var(--tentative-slot);
      min-height: var(--tentative-slot);
      max-height: var(--tentative-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: rgba(209, 213, 219, 0.58);
      font-size: ${TENTATIVE_FONT_SCALE}em;
      font-style: normal;
      font-weight: 450;
      line-height: ${TENTATIVE_LINE_HEIGHT};
      text-overflow: ellipsis;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.9);
      white-space: nowrap;
    }

    .translation-badge {
      position: absolute;
      top: 6px;
      right: 8px;
      z-index: 1;
      display: none;
      margin: 0;
      padding: 3px 7px;
      border: 1px solid rgba(253, 230, 138, 0.5);
      border-radius: 999px;
      color: #fef3c7;
      background: rgba(120, 53, 15, 0.9);
      font-size: 11px;
      font-style: normal;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      text-shadow: none;
      pointer-events: none;
    }

    .translation-badge.is-visible {
      display: inline-flex;
    }

    .chip {
      position: fixed;
      display: none;
      align-items: center;
      gap: 6px;
      min-height: 22px;
      margin: 0;
      padding: 4px 8px;
      border: 1px solid transparent;
      border-radius: 999px;
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      font-size: 12px;
      font-style: normal;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      pointer-events: none;
      transform: translateX(-100%);
      box-shadow:
        0 1px 3px rgba(0, 0, 0, 0.3);
      text-shadow: none;
    }

    .target-chip.status-loading,
    .target-chip.status-silent {
      color: #422006;
      background: rgba(253, 224, 71, 0.94);
      border-color: rgba(202, 138, 4, 0.8);
    }

    .target-chip.status-running {
      color: #f0fdf4;
      background: rgba(22, 163, 74, 0.94);
      border-color: rgba(187, 247, 208, 0.55);
    }

    .target-chip.status-error {
      color: #fff7f7;
      background: rgba(220, 38, 38, 0.95);
      border-color: rgba(254, 202, 202, 0.6);
    }

    .target-dot {
      display: none;
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: currentColor;
    }

    .status-running .target-dot {
      display: block;
      animation:
        xjsub-pulse 1.4s ease-in-out infinite;
    }

    .other-chip {
      color: rgba(255, 255, 255, 0.82);
      background: rgba(55, 65, 81, 0.5);
      border-color: rgba(209, 213, 219, 0.2);
      box-shadow: none;
      opacity: 0.72;
    }

    .other-layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }

    @keyframes xjsub-pulse {
      0%,
      100% {
        opacity: 0.45;
        transform: scale(0.88);
      }

      50% {
        opacity: 1;
        transform: scale(1.12);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .caption-line {
        transition-duration: 1ms;
      }

      .status-running .target-dot {
        animation: none;
        opacity: 1;
      }
    }
  `;
}
