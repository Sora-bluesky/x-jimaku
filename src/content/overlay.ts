import type {
  TranslationPath,
} from "../shared/messages";
import {
  cueDisplayDurationMs,
  decideCueQueueDiscipline,
  retainAccelerationUntilDrained,
} from "./cue-queue";
import type {
  SilentInputHintVariant,
} from "./silent-hint";

const HOST_ID = "xjsub-host";
const CAPTION_VISIBLE_MS = 5_000;
const CAPTION_FADE_MS = 350;
export const CUE_MINIMUM_DISPLAY_MS = 1_500;
export const CUE_ACCELERATED_DISPLAY_MS = 1_000;
export const CUE_ACCELERATION_THRESHOLD = 2;
export const MAX_WAITING_CUES = 6;
export const MAX_CUE_UNITS = 28;
const CUE_DROP_WARNING_INTERVAL_MS = 5_000;
const MAX_LINE_UNITS = 14;
const MIN_CUE_SEGMENT_CHARACTERS = 5;
const MIN_LINE_SEGMENT_CHARACTERS = 2;
const MAX_ORPHAN_CUE_CHARACTERS = 4;
const JAPANESE_PARTICLES:
  readonly string[] = [
    "から",
    "まで",
    "より",
    "は",
    "が",
    "を",
    "に",
    "で",
    "と",
    "へ",
    "の",
    "も",
    "て",
  ];
const SENTENCE_BOUNDARY_CHARACTER =
  /[。！？!?]/u;
const CLAUSE_BOUNDARY_CHARACTER =
  /[、,\s]/u;
const JAPANESE_PUNCTUATION_CHARACTER =
  /[。！？!?、,]/u;
const JAPANESE_PARTICLE_START_CHARACTER =
  /[はがをにでとへのもかまよて]/u;
const KATAKANA_CHARACTER =
  /[\p{Script=Katakana}ー]/u;
const MAX_ORIGINAL_CHARS = 140;
const PRIMARY_LINE_HEIGHT = 1.16;
const ORIGINAL_FONT_SCALE = 0.68;
const ORIGINAL_LINE_HEIGHT = 1.18;
const TENTATIVE_FONT_SCALE = 0.62;
const TENTATIVE_LINE_HEIGHT = 1.18;
const MUTATION_DEBOUNCE_MS = 500;
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
  formattedPrimary: string;
}

interface ActiveCue {
  data: CueData;
  shownAt: number;
  element: HTMLDivElement;
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
}

export type CaptionOverlayStatus =
  | "loadingModel"
  | "running"
  | "error";

export interface CaptionOverlayOptions {
  getTargetVideo(): HTMLVideoElement | null;
  showOriginal: boolean;
  onCaptionFadeOut?(): void;
}

export class CaptionOverlay {
  private readonly options:
    CaptionOverlayOptions;
  private readonly showOriginal: boolean;
  private readonly host: HTMLDivElement;
  private readonly captionStack:
    HTMLDivElement;
  private readonly translationBadge:
    HTMLDivElement;
  private readonly captionLine:
    HTMLDivElement;
  private readonly cueContainer:
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

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.setAttribute("popover", "manual");
    this.host.dataset.cueMutations = "0";
    this.host.dataset.cueDrops = "0";
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

    this.cueContainer.replaceChildren();
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
        this.acceptCommittedClause(line);
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
      this.playbackPaused === paused
    ) {
      return;
    }

    if (paused) {
      this.pauseCaptionDisplay();
      return;
    }

    this.resumeCaptionDisplay();
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

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
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
      this.waitingCues.length > 0
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

      return;
    }

    this.pendingFinals.delete(line.id);
    this.acceptCommittedClause({
      ...line,
      text,
      final: true,
      ...(ja === "" ? {} : { ja }),
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

    const cues =
      this.createCueSegments(line);

    if (cues.length === 0) {
      return;
    }

    this.acceptedFinalIds.add(line.id);
    this.captionBarEnabled = true;
    this.captionRevision += 1;
    this.cancelCaptionFade();

    for (const cue of cues) {
      this.waitingCues.push(cue);
      this.enforceQueueDiscipline();
      this.tryAdvanceCue();
    }

    this.updateCaptionVisibility();
  }

  private createCueSegments(
    line: CaptionLine,
  ): CueData[] {
    const source = line.text.trim();
    const translated =
      line.ja?.trim() ?? "";
    const useEnglish =
      translated === "" &&
      this.translationPath === "none";
    const primary =
      useEnglish ? source : translated;

    if (primary === "") {
      return [];
    }

    const parts = splitCueText(
      primary,
      MAX_CUE_UNITS,
    );
    const original =
      this.showOriginal &&
      !useEnglish &&
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
        formattedPrimary:
          wrapCueText(
            part,
            MAX_LINE_UNITS,
          ),
      }),
    );
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
          }),
        ),
        this.acceleratedUntilDrained,
        {
          maxWaitingCues:
            MAX_WAITING_CUES,
          maxCueUnits: MAX_CUE_UNITS,
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
          formattedPrimary:
            wrapCueText(
              combinedPrimary,
              MAX_LINE_UNITS,
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

  private tryAdvanceCue(): void {
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

    if (this.waitingCues.length === 0) {
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

    if (remaining > 0) {
      if (this.cueAdvanceTimerId === null) {
        this.cueAdvanceTimerId =
          window.setTimeout(() => {
            this.cueAdvanceTimerId = null;
            this.tryAdvanceCue();
          }, Math.ceil(remaining));
      }
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

    const element =
      this.createCueElement(cue);

    this.cueContainer.replaceChildren(
      element,
    );
    this.activeCue = {
      data: cue,
      shownAt: performance.now(),
      element,
    };

    this.captionLine.classList.remove(
      "is-empty",
      "is-fading",
    );

    this.updateCaptionVisibility();

    if (this.waitingCues.length > 0) {
      this.tryAdvanceCue();
    } else {
      this.acceleratedUntilDrained =
        retainAccelerationUntilDrained(
          this.acceleratedUntilDrained,
          this.waitingCues.length,
        );
      this.scheduleCaptionFade();
    }
  }

  private createCueElement(
    cue: CueData,
  ): HTMLDivElement {
    const element =
      document.createElement("div");
    element.className = "caption-cue";
    element.dataset.cueId = cue.cueId;

    const primary =
      document.createElement("div");
    primary.className =
      "caption-primary";
    primary.textContent =
      cue.formattedPrimary;

    const original =
      document.createElement("div");
    original.className =
      "caption-original";
    original.textContent =
      cue.originalText;

    element.append(primary, original);
    this.cueTextSnapshots.set(
      element,
      element.textContent ?? "",
    );

    return element;
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
      this.activeCue !== null ||
      this.tentativeLine.textContent !== "";

    this.captionLine.classList.toggle(
      "is-empty",
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
    } else {
      this.positionCaptionStack(rect);
      this.positionTargetChip(rect);
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
    const hasTentative =
      this.tentativeLine.textContent !== "";
    const barHeight =
      this.showOriginal
        ? Math.max(
            76,
            Math.min(
              hasTentative ? 124 : 108,
              rect.height *
                (hasTentative ? 0.29 : 0.25),
            ),
          )
        : Math.max(
            56,
            Math.min(
              hasTentative ? 104 : 90,
              rect.height *
                (hasTentative ? 0.23 : 0.19),
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
    const rowHeightUnits =
      PRIMARY_LINE_HEIGHT * 2 +
      (
        this.showOriginal
          ? ORIGINAL_FONT_SCALE *
            ORIGINAL_LINE_HEIGHT
          : 0
      ) +
      (
        hasTentative
          ? TENTATIVE_FONT_SCALE *
            TENTATIVE_LINE_HEIGHT
          : 0
      );
    const widthScaledFontSize = Math.max(
      14,
      Math.min(24, rect.width / 32),
    );
    const heightLimitedFontSize =
      availableHeight / rowHeightUnits;
    const fontSize = Math.max(
      10,
      Math.min(
        widthScaledFontSize,
        heightLimitedFontSize,
      ),
    );

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
    this.captionStack.style.setProperty(
      "--primary-slot",
      `${
        fontSize *
        PRIMARY_LINE_HEIGHT *
        2
      }px`,
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
        hasTentative
          ? fontSize *
            TENTATIVE_FONT_SCALE *
            TENTATIVE_LINE_HEIGHT
          : 0
      }px`,
    );
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
          this.waitingCues.length > 0
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
          this.waitingCues.length > 0
        ) {
          return;
        }

        this.activeCue = null;
        this.clearTentative();
        this.cueContainer.replaceChildren();
        this.resetCaptionFadeVisualState();
        this.captionLine.classList.add(
          "is-empty",
        );
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

export function splitCueText(
  text: string,
  maxUnits: number = MAX_CUE_UNITS,
): string[] {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized === "") {
    return [];
  }

  const characters = Array.from(normalized);
  const protectedRanges =
    findProtectedUrlRanges(normalized);
  const parts: string[] = [];
  let start = 0;

  while (start < characters.length) {
    const end =
      findMaximumUnitBoundary(
        characters,
        start,
        maxUnits,
      );

    if (end >= characters.length) {
      const tail =
        characters.slice(start).join("").trim();

      if (tail !== "") {
        parts.push(tail);
      }
      break;
    }

    let target = end;

    if (
      segmentCharacterCount(
        characters,
        end,
        characters.length,
      ) <= MAX_ORPHAN_CUE_CHARACTERS
    ) {
      target = findOrphanSafeTarget(
        characters,
        start,
        end,
      );
    }

    const boundary =
      findNaturalTextBoundary(
        normalized,
        characters,
        start,
        target,
        MIN_CUE_SEGMENT_CHARACTERS,
        protectedRanges,
      );
    const part = characters
      .slice(start, boundary)
      .join("")
      .trim();

    if (part !== "") {
      parts.push(part);
    }

    start = boundary;

    while (
      characters[start] !== undefined &&
      /\s/u.test(characters[start] ?? "")
    ) {
      start += 1;
    }
  }

  return parts;
}

export function wrapCueText(
  text: string,
  maxLineUnits: number =
    MAX_LINE_UNITS,
): string {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim();

  if (
    normalized === "" ||
    displayUnits(normalized) <=
      maxLineUnits
  ) {
    return normalized;
  }

  const characters = Array.from(normalized);
  const protectedRanges =
    findProtectedUrlRanges(normalized);
  const balancedTarget =
    findMaximumUnitBoundary(
      characters,
      0,
      displayUnits(normalized) / 2,
    );
  const maximumLineBoundary =
    findMaximumUnitBoundary(
      characters,
      0,
      maxLineUnits,
    );
  const minimumLineBoundary =
    findMinimumRemainderBoundary(
      characters,
      maxLineUnits,
    );
  const boundary =
    findNaturalTextBoundary(
      normalized,
      characters,
      0,
      balancedTarget,
      MIN_LINE_SEGMENT_CHARACTERS,
      protectedRanges,
      minimumLineBoundary,
      maximumLineBoundary,
    );
  const first = characters
    .slice(0, boundary)
    .join("")
    .trim();
  const second = characters
    .slice(boundary)
    .join("")
    .trim();

  return second === ""
    ? first
    : `${first}\n${second}`;
}

function findMinimumRemainderBoundary(
  characters: readonly string[],
  maxUnits: number,
): number {
  let units = 0;
  let boundary = characters.length;

  while (boundary > 0) {
    const character =
      characters[boundary - 1] ?? "";
    const nextUnits =
      units + characterUnits(character);

    if (nextUnits > maxUnits) {
      break;
    }

    units = nextUnits;
    boundary -= 1;
  }

  return Math.max(1, boundary);
}

function findMaximumUnitBoundary(
  characters: readonly string[],
  start: number,
  maxUnits: number,
): number {
  let units = 0;
  let end = start;

  while (end < characters.length) {
    const character =
      characters[end] ?? "";
    const nextUnits =
      units + characterUnits(character);

    if (
      nextUnits > maxUnits &&
      end > start
    ) {
      break;
    }

    units = nextUnits;
    end += 1;
  }

  return end;
}

function findOrphanSafeTarget(
  characters: readonly string[],
  start: number,
  target: number,
): number {
  let redistributed = target;

  while (
    redistributed > start + 1 &&
    segmentCharacterCount(
      characters,
      redistributed,
      characters.length,
    ) <= MAX_ORPHAN_CUE_CHARACTERS
  ) {
    redistributed -= 1;
  }

  return redistributed;
}

function segmentCharacterCount(
  characters: readonly string[],
  start: number,
  end: number,
): number {
  return Array.from(
    characters
      .slice(start, end)
      .join("")
      .trim(),
  ).length;
}

function findNaturalTextBoundary(
  text: string,
  characters: readonly string[],
  start: number,
  target: number,
  minimumSegmentCharacters: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
  minimumBoundary: number = start + 1,
  maximumBoundaryLimit: number = target,
): number {
  let bestBoundary: number | null = null;
  let bestEffectiveDistance =
    Number.POSITIVE_INFINITY;
  let bestDistance =
    Number.POSITIVE_INFINITY;

  const maximumBoundary = Math.min(
    maximumBoundaryLimit,
    characters.length - 1,
  );

  for (
    let boundary = Math.max(
      start + 1,
      minimumBoundary,
    );
    boundary <= maximumBoundary;
    boundary += 1
  ) {
    if (
      !isSegmentBoundaryAllowed(
        text,
        characters,
        start,
        boundary,
        minimumSegmentCharacters,
        ranges,
      )
    ) {
      continue;
    }

    const bonus =
      naturalBoundaryBonus(
        characters,
        start,
        boundary,
      );

    if (bonus === null) {
      continue;
    }

    const distance =
      Math.abs(boundary - target);
    const effectiveDistance =
      distance - bonus;

    if (
      effectiveDistance <
        bestEffectiveDistance ||
      (
        effectiveDistance ===
          bestEffectiveDistance &&
        (
          distance < bestDistance ||
          (
            distance === bestDistance &&
            (
              bestBoundary === null ||
              boundary < bestBoundary
            )
          )
        )
      )
    ) {
      bestBoundary = boundary;
      bestEffectiveDistance =
        effectiveDistance;
      bestDistance = distance;
    }
  }

  return (
    bestBoundary ??
    findFallbackCueBoundary(
      text,
      characters,
      start,
      target,
      minimumSegmentCharacters,
      ranges,
      minimumBoundary,
      maximumBoundaryLimit,
    )
  );
}

function naturalBoundaryBonus(
  characters: readonly string[],
  start: number,
  boundary: number,
): number | null {
  const previous =
    characters[boundary - 1] ?? "";

  if (
    SENTENCE_BOUNDARY_CHARACTER.test(
      previous,
    )
  ) {
    return 6;
  }

  if (
    CLAUSE_BOUNDARY_CHARACTER.test(
      previous,
    )
  ) {
    return 3;
  }

  if (
    !endsWithJapaneseParticle(
      characters,
      start,
      boundary,
    )
  ) {
    return null;
  }

  const next = characters[boundary] ?? "";

  if (
    JAPANESE_PARTICLE_START_CHARACTER.test(
      next,
    ) ||
    JAPANESE_PUNCTUATION_CHARACTER.test(
      next,
    )
  ) {
    return null;
  }

  return 1;
}

function endsWithJapaneseParticle(
  characters: readonly string[],
  start: number,
  boundary: number,
): boolean {
  return JAPANESE_PARTICLES.some(
    (particle) => {
      const particleCharacters =
        Array.from(particle);
      const particleStart =
        boundary -
        particleCharacters.length;

      return (
        particleStart >= start &&
        particleCharacters.every(
          (character, index) =>
            characters[
              particleStart + index
            ] === character,
        )
      );
    },
  );
}

function isSegmentBoundaryAllowed(
  text: string,
  characters: readonly string[],
  start: number,
  boundary: number,
  minimumSegmentCharacters: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
): boolean {
  return (
    segmentCharacterCount(
      characters,
      start,
      boundary,
    ) >= minimumSegmentCharacters &&
    segmentCharacterCount(
      characters,
      boundary,
      characters.length,
    ) >= minimumSegmentCharacters &&
    !isCharacterBoundaryProtected(
      text,
      characters,
      boundary,
      ranges,
    ) &&
    !isInsideKatakanaRun(
      characters,
      boundary,
    )
  );
}

function isInsideKatakanaRun(
  characters: readonly string[],
  boundary: number,
): boolean {
  return (
    KATAKANA_CHARACTER.test(
      characters[boundary - 1] ?? "",
    ) &&
    KATAKANA_CHARACTER.test(
      characters[boundary] ?? "",
    )
  );
}

function findFallbackCueBoundary(
  text: string,
  characters: readonly string[],
  start: number,
  target: number,
  minimumSegmentCharacters: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
  minimumBoundary: number = start + 1,
  maximumBoundaryLimit: number = target,
): number {
  let nearestBoundary: number | null = null;
  let nearestDistance =
    Number.POSITIVE_INFINITY;
  const maximumBoundary = Math.min(
    maximumBoundaryLimit,
    characters.length - 1,
  );

  for (
    let boundary = Math.max(
      start + 1,
      minimumBoundary,
    );
    boundary <= maximumBoundary;
    boundary += 1
  ) {
    if (
      !isSegmentBoundaryAllowed(
        text,
        characters,
        start,
        boundary,
        minimumSegmentCharacters,
        ranges,
      )
    ) {
      continue;
    }

    const distance =
      Math.abs(boundary - target);

    if (
      distance < nearestDistance ||
      (
        distance === nearestDistance &&
        (
          nearestBoundary === null ||
          boundary < nearestBoundary
        )
      )
    ) {
      nearestBoundary = boundary;
      nearestDistance = distance;
    }
  }

  if (nearestBoundary !== null) {
    return nearestBoundary;
  }

  return findConventionalCueBoundary(
    text,
    characters,
    start,
    maximumBoundaryLimit,
    ranges,
  );
}

function findConventionalCueBoundary(
  text: string,
  characters: readonly string[],
  start: number,
  target: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
): number {
  const minimum = start + 1;
  const maximum = characters.length - 1;

  for (
    let boundary = Math.min(target, maximum);
    boundary >= minimum;
    boundary -= 1
  ) {
    if (
      !isCharacterBoundaryProtected(
        text,
        characters,
        boundary,
        ranges,
      )
    ) {
      return boundary;
    }
  }

  for (
    let boundary =
      Math.max(minimum, target + 1);
    boundary <= maximum;
    boundary += 1
  ) {
    if (
      !isCharacterBoundaryProtected(
        text,
        characters,
        boundary,
        ranges,
      )
    ) {
      return boundary;
    }
  }

  return Math.min(
    characters.length,
    Math.max(start + 1, target),
  );
}

function displayUnits(
  text: string,
): number {
  let units = 0;

  for (const character of text) {
    units += characterUnits(character);
  }

  return units;
}

function characterUnits(
  character: string,
): number {
  return /[\u0000-\u00ff]/u.test(
    character,
  )
    ? 0.5
    : 1;
}

function findProtectedUrlRanges(
  text: string,
): ReadonlyArray<
  readonly [start: number, end: number]
> {
  const ranges:
    Array<readonly [number, number]> = [];
  const expression =
    /(?:https?:\/\/|www\.)\S+/giu;

  for (
    let match = expression.exec(text);
    match !== null;
    match = expression.exec(text)
  ) {
    ranges.push([
      match.index,
      match.index + match[0].length,
    ]);
  }

  return ranges;
}

function isCharacterBoundaryProtected(
  text: string,
  characters: readonly string[],
  boundary: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
): boolean {
  const prefix = characters
    .slice(0, boundary)
    .join("");
  const codeUnitBoundary =
    prefix.length;

  return ranges.some(
    ([start, end]) =>
      codeUnitBoundary > start &&
      codeUnitBoundary < end &&
      end <= text.length,
  );
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
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
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
      flex: 0 0 var(--primary-slot);
      width: 100%;
      min-width: 0;
      height: var(--primary-slot);
      min-height: var(--primary-slot);
      max-height: var(--primary-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      overflow-wrap: normal;
      font-size: 1em;
      font-style: normal;
      font-weight: 650;
      line-height: ${PRIMARY_LINE_HEIGHT};
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
