import type {
  TranslationPath,
} from "../shared/messages";

const MAX_PRIMARY_CAPTION_CHARS = 120;
const MAX_SECONDARY_CAPTION_CHARS = 140;

const PRIMARY_LINE_HEIGHT = 1.16;
const ORIGINAL_FONT_SCALE = 0.68;
const ORIGINAL_LINE_HEIGHT = 1.18;
const MAX_STALE_INTERIM_ADVANCES = 2;

function clampCaptionTail(
  text: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  return "…" + text.slice(text.length - maxChars);
}

const HOST_ID = "xjsub-host";
const CAPTION_VISIBLE_MS = 5_000;
const CAPTION_FADE_MS = 350;
const MUTATION_DEBOUNCE_MS = 500;
const MAX_OTHER_VIDEOS = 6;
const STABLE_FRAMES_BEFORE_IDLE = 10;
const RECT_COMPARISON_EPSILON_PX = 0.1;

type CaptionSource =
  | "interim"
  | "final";

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
  private readonly options: CaptionOverlayOptions;
  private readonly showOriginal: boolean;
  private readonly host: HTMLDivElement;
  private readonly captionStack: HTMLDivElement;
  private readonly translationBadge:
    HTMLDivElement;
  private readonly captionLine: HTMLDivElement;
  private readonly primaryLine: HTMLDivElement;
  private readonly originalLine: HTMLDivElement;
  private readonly targetChip: HTMLDivElement;
  private readonly targetDot: HTMLSpanElement;
  private readonly targetText: HTMLSpanElement;
  private readonly otherLayer: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly mutationObserver: MutationObserver;

  private readonly otherBadges =
    new Map<HTMLVideoElement, HTMLDivElement>();

  private targetVideo: HTMLVideoElement | null =
    null;
  private mutationRoot: Node | null = null;
  private status: CaptionOverlayStatus =
    "loadingModel";
  private translationPath:
    | TranslationPath
    | null = null;
  private progress: number | undefined;

  private highestFinalId: number | null = null;
  private highestShownFinalId:
    | number
    | null = null;
  private activeShownFinalId:
    | number
    | null = null;

  private finalId: number | null = null;
  private finalAt: string | null = null;
  private finalEnglishText = "";
  private finalJapaneseText = "";

  private interimId: number | null = null;
  private interimEnglishText = "";
  private interimJapaneseText = "";
  private interimEnglishAt: string | null =
    null;
  private interimSnapshotVersion = 0;
  private interimJapaneseVersion:
    | number
    | null = null;

  private liveEnglishId: number | null = null;
  private liveEnglishSource:
    | CaptionSource
    | null = null;
  private liveEnglishText = "";

  private japaneseDisplayId:
    | number
    | null = null;
  private japaneseDisplaySource:
    | CaptionSource
    | null = null;
  private japaneseDisplayText = "";

  private captionActive = false;
  private suppressedAfterFade = false;
  private captionRevision = 0;

  private frameId: number | null = null;
  private stableFrameCount = 0;
  private lastLayoutSnapshot:
    | LayoutSnapshot
    | null = null;
  private mutationTimerId: number | null =
    null;
  private captionFadeTimerId:
    | number
    | null = null;
  private captionRemovalTimerId:
    | number
    | null = null;
  private captionBarEnabled = true;
  private destroyed = false;

  constructor(options: CaptionOverlayOptions) {
    this.options = options;
    this.showOriginal =
      options.showOriginal;

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.setAttribute("popover", "manual");
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

    this.primaryLine =
      document.createElement("div");
    this.primaryLine.className =
      "caption-primary";

    this.originalLine =
      document.createElement("div");
    this.originalLine.className =
      "caption-original";

    this.captionLine.append(
      this.primaryLine,
      this.originalLine,
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

    const text = line.text.trim();
    const ja = line.ja?.trim() ?? "";

    if (line.final) {
      this.showFinalCaption(
        line,
        text,
        ja,
      );
    } else {
      this.showInterimCaption(
        line,
        text,
        ja,
      );
    }

    this.refreshTarget();
    this.updateLayout();
    this.startFrameLoop();
  }

  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.captionRevision += 1;
    this.cancelCaptionFade();
    this.captionBarEnabled = false;
    this.captionActive = false;
    this.suppressedAfterFade = true;
    this.activeShownFinalId = null;

    this.finalId = null;
    this.finalAt = null;
    this.finalEnglishText = "";
    this.finalJapaneseText = "";

    this.clearInterimCaptionState();

    this.liveEnglishId = null;
    this.liveEnglishSource = null;
    this.liveEnglishText = "";
    this.japaneseDisplayText = "";

    this.clearRenderedCaption();
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

    if (
      !this.captionActive &&
      !this.suppressedAfterFade &&
      path === "none" &&
      this.liveEnglishText !== ""
    ) {
      this.captionActive = true;
    }

    this.cancelCaptionFade();
    this.renderCaption();
    this.syncCaptionFadeAfterRender();
    this.updateLayout();
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
        : Math.min(100, Math.max(0, progress));

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
    this.cancelCaptionFade();

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
    this.resizeObserver.disconnect();
    this.otherBadges.clear();
    this.targetVideo = null;
    this.lastLayoutSnapshot = null;
    this.hideHostPopover();
    this.host.remove();

    console.log("[overlay]", "overlay destroyed");
  }

  private showFinalCaption(
    line: CaptionLine,
    text: string,
    ja: string,
  ): void {
    const highestShownFinalId =
      this.highestShownFinalId;

    if (
      highestShownFinalId !== null &&
      line.id < highestShownFinalId
    ) {
      return;
    }

    if (
      highestShownFinalId === line.id &&
      this.activeShownFinalId !== line.id
    ) {
      return;
    }

    if (text === "") {
      return;
    }

    if (
      this.finalId !== null &&
      line.id < this.finalId
    ) {
      return;
    }

    const isNewFinal =
      this.finalId !== line.id;

    if (
      !isNewFinal &&
      this.finalAt !== null &&
      line.at < this.finalAt
    ) {
      return;
    }

    const previousFinalAt = this.finalAt;
    const previousEnglish =
      this.finalEnglishText;
    const previousJapanese =
      this.finalJapaneseText;

    this.highestFinalId =
      this.highestFinalId === null
        ? line.id
        : Math.max(
            this.highestFinalId,
            line.id,
          );

    if (isNewFinal) {
      this.finalId = line.id;
      this.finalAt = line.at;
      this.finalEnglishText = text;
      this.finalJapaneseText = "";
    } else {
      this.finalAt = line.at;
      this.finalEnglishText = text;
    }

    if (ja !== "") {
      this.finalJapaneseText = ja;
    }

    if (
      this.interimId === line.id ||
      (
        this.interimId !== null &&
        this.interimId < line.id
      )
    ) {
      this.clearInterimCaptionState();
    }

    const liveEnglishUpdated =
      this.updateLiveEnglish(
        line.id,
        "final",
        text,
      );
    const japaneseUpdated =
      ja !== "" &&
      this.updateJapaneseDisplay(
        line.id,
        "final",
        ja,
      );
    const finalStateChanged =
      isNewFinal ||
      previousFinalAt !== line.at ||
      previousEnglish !==
        this.finalEnglishText ||
      previousJapanese !==
        this.finalJapaneseText;

    const hasNewActivity =
      liveEnglishUpdated ||
      japaneseUpdated ||
      finalStateChanged;
    const canActivate =
      japaneseUpdated ||
      (
        (
          this.translationPath === "none" ||
          this.showOriginal
        ) &&
        (
          liveEnglishUpdated ||
          finalStateChanged
        )
      );

    this.applyCaptionUpdate(
      canActivate,
      hasNewActivity,
    );
  }

  private showInterimCaption(
    line: CaptionLine,
    text: string,
    ja: string,
  ): void {
    if (
      (
        this.highestFinalId !== null &&
        line.id <= this.highestFinalId
      ) ||
      (
        this.interimId !== null &&
        line.id < this.interimId
      )
    ) {
      return;
    }

    if (text === "") {
      return;
    }

    if (
      this.interimId === null ||
      line.id > this.interimId
    ) {
      this.beginInterimCaption(line.id);
    }

    let interimStateChanged = false;

    if (ja === "") {
      if (
        !this.shouldAdvanceInterimSnapshot(
          line.at,
          text,
        )
      ) {
        return;
      }

      this.advanceInterimSnapshot(
        line.at,
        text,
      );
      interimStateChanged = true;
    } else {
      const previousEnglishAt =
        this.interimEnglishAt;
      const previousEnglish =
        this.interimEnglishText;
      const previousJapanese =
        this.interimJapaneseText;
      const previousJapaneseVersion =
        this.interimJapaneseVersion;

      if (
        !this.matchOrAdvanceTranslatedInterim(
          line.at,
          text,
        )
      ) {
        return;
      }

      this.interimJapaneseText = ja;
      this.interimJapaneseVersion =
        this.interimSnapshotVersion;

      interimStateChanged =
        previousEnglishAt !==
          this.interimEnglishAt ||
        previousEnglish !==
          this.interimEnglishText ||
        previousJapanese !==
          this.interimJapaneseText ||
        previousJapaneseVersion !==
          this.interimJapaneseVersion;
    }

    const liveEnglishUpdated =
      this.updateLiveEnglish(
        line.id,
        "interim",
        this.interimEnglishText,
      );
    const japaneseUpdated =
      ja !== "" &&
      this.updateJapaneseDisplay(
        line.id,
        "interim",
        ja,
      );
    const hasNewActivity =
      interimStateChanged ||
      liveEnglishUpdated ||
      japaneseUpdated;
    const canActivate =
      japaneseUpdated ||
      (
        (
          this.translationPath === "none" ||
          this.showOriginal
        ) &&
        hasNewActivity
      );

    this.applyCaptionUpdate(
      canActivate,
      hasNewActivity,
    );
  }

  private beginInterimCaption(
    id: number,
  ): void {
    this.interimId = id;
    this.interimEnglishText = "";
    this.interimJapaneseText = "";
    this.interimEnglishAt = null;
    this.interimSnapshotVersion = 0;
    this.interimJapaneseVersion = null;
  }

  private shouldAdvanceInterimSnapshot(
    at: string,
    text: string,
  ): boolean {
    if (this.interimEnglishAt === null) {
      return true;
    }

    return (
      at > this.interimEnglishAt ||
      (
        at === this.interimEnglishAt &&
        text !== this.interimEnglishText
      )
    );
  }

  private advanceInterimSnapshot(
    at: string,
    text: string,
  ): void {
    this.interimSnapshotVersion += 1;
    this.interimEnglishAt = at;
    this.interimEnglishText = text;

    if (
      this.interimJapaneseVersion !== null &&
      this.interimSnapshotVersion -
        this.interimJapaneseVersion >=
        MAX_STALE_INTERIM_ADVANCES
    ) {
      this.interimJapaneseText = "";
      this.interimJapaneseVersion = null;
    }
  }

  private matchOrAdvanceTranslatedInterim(
    at: string,
    text: string,
  ): boolean {
    if (this.interimEnglishAt === null) {
      this.advanceInterimSnapshot(
        at,
        text,
      );
      return true;
    }

    if (at < this.interimEnglishAt) {
      return false;
    }

    if (at > this.interimEnglishAt) {
      this.advanceInterimSnapshot(
        at,
        text,
      );
      return true;
    }

    return text === this.interimEnglishText;
  }

  private clearInterimCaptionState(): void {
    this.interimId = null;
    this.interimEnglishText = "";
    this.interimJapaneseText = "";
    this.interimEnglishAt = null;
    this.interimSnapshotVersion = 0;
    this.interimJapaneseVersion = null;
  }

  private updateLiveEnglish(
    id: number,
    source: CaptionSource,
    text: string,
  ): boolean {
    if (
      this.liveEnglishId !== null &&
      this.liveEnglishSource !== null &&
      compareCaptionOrder(
        id,
        source,
        this.liveEnglishId,
        this.liveEnglishSource,
      ) < 0
    ) {
      return false;
    }

    const changed =
      this.liveEnglishId !== id ||
      this.liveEnglishSource !== source ||
      this.liveEnglishText !== text;

    this.liveEnglishId = id;
    this.liveEnglishSource = source;
    this.liveEnglishText = text;

    if (
      this.activeShownFinalId !== null &&
      id > this.activeShownFinalId
    ) {
      this.activeShownFinalId = null;
    }

    return changed;
  }

  private updateJapaneseDisplay(
    id: number,
    source: CaptionSource,
    text: string,
  ): boolean {
    if (
      this.japaneseDisplayId !== null &&
      this.japaneseDisplaySource !== null &&
      compareCaptionOrder(
        id,
        source,
        this.japaneseDisplayId,
        this.japaneseDisplaySource,
      ) < 0
    ) {
      return false;
    }

    const changed =
      this.japaneseDisplayId !== id ||
      this.japaneseDisplaySource !== source ||
      this.japaneseDisplayText !== text;

    this.japaneseDisplayId = id;
    this.japaneseDisplaySource = source;
    this.japaneseDisplayText = text;

    if (
      this.activeShownFinalId !== null &&
      (
        id > this.activeShownFinalId ||
        (
          id === this.activeShownFinalId &&
          source === "interim"
        )
      )
    ) {
      this.activeShownFinalId = null;
    }

    return changed;
  }

  private applyCaptionUpdate(
    canActivate: boolean,
    hasNewActivity: boolean,
  ): void {
    if (!hasNewActivity) {
      return;
    }

    this.captionRevision += 1;
    this.captionBarEnabled = true;
    this.suppressedAfterFade = false;

    if (canActivate) {
      this.captionActive = true;
    }

    this.cancelCaptionFade();
    this.renderCaption();
    this.syncCaptionFadeAfterRender();
  }

  private renderCaption(): void {
    if (!this.captionActive) {
      this.clearRenderedCaption();
      return;
    }

    const useEnglishFallback =
      this.translationPath === "none";

    if (useEnglishFallback) {
      this.primaryLine.textContent =
        clampCaptionTail(
          this.liveEnglishText,
          MAX_SECONDARY_CAPTION_CHARS,
        );
      this.originalLine.textContent = "";
    } else {
      this.primaryLine.textContent =
        this.japaneseDisplayText === ""
          ? ""
          : clampCaptionTail(
              this.japaneseDisplayText,
              MAX_PRIMARY_CAPTION_CHARS,
            );
      this.originalLine.textContent =
        this.showOriginal &&
        this.liveEnglishText !== ""
          ? clampCaptionTail(
              this.liveEnglishText,
              MAX_SECONDARY_CAPTION_CHARS,
            )
          : "";
    }

    const hasVisibleText =
      this.hasVisibleCaption();

    this.captionLine.classList.toggle(
      "is-empty",
      !hasVisibleText,
    );

    if (!hasVisibleText) {
      return;
    }

    this.recordVisibleFinal();
  }

  private clearRenderedCaption(): void {
    this.primaryLine.textContent = "";
    this.originalLine.textContent = "";
    this.captionLine.classList.remove(
      "is-fading",
    );
    this.captionLine.classList.add(
      "is-empty",
    );
  }

  private recordVisibleFinal(): void {
    let visibleFinalId: number | null = null;

    if (
      this.translationPath === "none" &&
      this.liveEnglishSource === "final" &&
      this.liveEnglishId !== null &&
      this.primaryLine.textContent !== ""
    ) {
      visibleFinalId = this.liveEnglishId;
    }

    if (
      this.translationPath !== "none" &&
      this.japaneseDisplaySource === "final" &&
      this.japaneseDisplayId !== null &&
      this.primaryLine.textContent !== ""
    ) {
      visibleFinalId =
        visibleFinalId === null
          ? this.japaneseDisplayId
          : Math.max(
              visibleFinalId,
              this.japaneseDisplayId,
            );
    }

    if (
      this.translationPath !== "none" &&
      this.showOriginal &&
      this.liveEnglishSource === "final" &&
      this.liveEnglishId !== null &&
      this.originalLine.textContent !== ""
    ) {
      visibleFinalId =
        visibleFinalId === null
          ? this.liveEnglishId
          : Math.max(
              visibleFinalId,
              this.liveEnglishId,
            );
    }

    this.activeShownFinalId = visibleFinalId;

    if (visibleFinalId === null) {
      return;
    }

    this.highestShownFinalId =
      this.highestShownFinalId === null
        ? visibleFinalId
        : Math.max(
            this.highestShownFinalId,
            visibleFinalId,
          );
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
      if (document.visibilityState === "visible") {
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
      // A later lifecycle pass retries after the
      // document or fullscreen state settles.
    }
  }

  private hideHostPopover(): void {
    if (!this.isHostPopoverOpen()) {
      return;
    }

    try {
      this.host.hidePopover();
    } catch {
      // The browser may already have closed it
      // during a top-layer state transition.
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
      document.body ?? document.documentElement;

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

    const desired = new Set<HTMLVideoElement>();

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

    for (const [video, badge] of this.otherBadges) {
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
    const barHeight =
      this.showOriginal
        ? Math.max(
            58,
            Math.min(
              94,
              rect.height * 0.21,
            ),
          )
        : Math.max(
            40,
            Math.min(
              76,
              rect.height * 0.14,
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
      Math.min(10, barHeight * 0.1),
    );
    const availableRowHeight = Math.max(
      1,
      barHeight - verticalPadding * 2,
    );
    const rowHeightInFontUnits =
      PRIMARY_LINE_HEIGHT +
      (
        this.showOriginal
          ? ORIGINAL_FONT_SCALE *
            ORIGINAL_LINE_HEIGHT
          : 0
      );
    const widthScaledFontSize = Math.max(
      14,
      Math.min(24, rect.width / 32),
    );
    const heightLimitedFontSize =
      availableRowHeight /
      rowHeightInFontUnits;
    const fontSize = Math.max(
      10,
      Math.min(
        widthScaledFontSize,
        heightLimitedFontSize,
      ),
    );
    const primarySlot =
      fontSize * PRIMARY_LINE_HEIGHT;
    const originalSlot =
      this.showOriginal
        ? fontSize *
          ORIGINAL_FONT_SCALE *
          ORIGINAL_LINE_HEIGHT
        : 0;

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
      `${primarySlot}px`,
    );
    this.captionStack.style.setProperty(
      "--original-slot",
      `${originalSlot}px`,
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
    for (const badge of this.otherBadges.values()) {
      badge.style.display = "none";
    }
  }

  private hasVisibleCaption(): boolean {
    return (
      this.primaryLine.textContent !== "" ||
      this.originalLine.textContent !== ""
    );
  }

  private syncCaptionFadeAfterRender(): void {
    if (
      !this.captionActive ||
      !this.hasVisibleCaption()
    ) {
      this.cancelCaptionFade();
      return;
    }

    this.scheduleCaptionFade();
  }

  private scheduleCaptionFade(): void {
    if (
      this.destroyed ||
      !this.captionActive ||
      !this.hasVisibleCaption() ||
      this.captionFadeTimerId !== null ||
      this.captionRemovalTimerId !== null
    ) {
      return;
    }

    const expiringRevision =
      this.captionRevision;

    this.captionFadeTimerId =
      window.setTimeout(() => {
        this.captionFadeTimerId = null;

        if (
          this.captionRevision !==
            expiringRevision ||
          !this.captionActive
        ) {
          return;
        }

        this.captionLine.classList.add(
          "is-fading",
        );

        this.captionRemovalTimerId =
          window.setTimeout(() => {
            this.captionRemovalTimerId = null;

            if (
              this.captionRevision !==
                expiringRevision ||
              !this.captionActive
            ) {
              return;
            }

            this.captionActive = false;
            this.suppressedAfterFade = true;
            this.activeShownFinalId = null;
            this.japaneseDisplayText = "";
            this.clearRenderedCaption();
            this.updateLayout();
            this.options.onCaptionFadeOut?.();
          }, CAPTION_FADE_MS);
      }, CAPTION_VISIBLE_MS);
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

    this.captionLine.classList.remove(
      "is-fading",
    );
  }
}

function compareCaptionOrder(
  leftId: number,
  leftSource: CaptionSource,
  rightId: number,
  rightSource: CaptionSource,
): number {
  if (leftId < rightId) {
    return -1;
  }

  if (leftId > rightId) {
    return 1;
  }

  if (leftSource === rightSource) {
    return 0;
  }

  return leftSource === "final" ? 1 : -1;
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
      leftLayout.video !== rightLayout.video ||
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
    approximatelyEqual(left.left, right.left) &&
    approximatelyEqual(left.top, right.top) &&
    approximatelyEqual(left.right, right.right) &&
    approximatelyEqual(left.bottom, right.bottom) &&
    approximatelyEqual(left.width, right.width) &&
    approximatelyEqual(left.height, right.height)
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
      --primary-slot: 24px;
      --original-slot: 0px;

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
        var(--original-slot)
      );
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: #ffffff;
      font-style: normal;
      font-weight: 650;
      pointer-events: none;
      opacity: 1;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.95),
        0 0 3px rgba(0, 0, 0, 0.8);
      transition:
        opacity ${CAPTION_FADE_MS}ms ease;
    }

    .caption-line.is-empty,
    .caption-line.is-fading {
      opacity: 0;
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
      font-weight: 650;
      line-height: ${PRIMARY_LINE_HEIGHT};
      text-overflow: ellipsis;
      white-space: nowrap;
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
      font-weight: 500;
      line-height: ${ORIGINAL_LINE_HEIGHT};
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

    .target-chip.status-loading {
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
