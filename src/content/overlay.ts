import type {
  TranslationPath,
} from "../shared/messages";

const MAX_PRIMARY_CAPTION_CHARS = 120;
const MAX_SECONDARY_CAPTION_CHARS = 140;

const FINAL_PRIMARY_LINE_HEIGHT = 1.16;
const FINAL_ORIGINAL_FONT_SCALE = 0.68;
const FINAL_ORIGINAL_LINE_HEIGHT = 1.18;
const INTERIM_PRIMARY_FONT_SCALE = 0.86;
const INTERIM_PRIMARY_LINE_HEIGHT = 1.16;
const INTERIM_ORIGINAL_FONT_SCALE = 0.64;
const INTERIM_ORIGINAL_LINE_HEIGHT = 1.16;
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
const FINAL_VISIBLE_MS = 5_000;
const FINAL_FADE_MS = 350;
const MUTATION_DEBOUNCE_MS = 500;
const MAX_OTHER_VIDEOS = 6;

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
  private readonly finalLine: HTMLDivElement;
  private readonly finalPrimaryLine:
    HTMLDivElement;
  private readonly finalOriginalLine:
    HTMLDivElement;
  private readonly interimLine: HTMLDivElement;
  private readonly interimPrimaryLine:
    HTMLDivElement;
  private readonly interimOriginalLine:
    HTMLDivElement;
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
  private finalId: number | null = null;
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
  private frameId: number | null = null;
  private mutationTimerId: number | null =
    null;
  private finalFadeTimerId: number | null =
    null;
  private finalRemovalTimerId: number | null =
    null;
  private captionBarEnabled = true;
  private destroyed = false;

  constructor(options: CaptionOverlayOptions) {
    this.options = options;
    this.showOriginal =
      options.showOriginal;

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    this.host.style.position = "fixed";
    this.host.style.inset = "0";
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

    this.finalLine =
      document.createElement("div");
    this.finalLine.className =
      "caption-line caption-final is-empty";

    this.finalPrimaryLine =
      document.createElement("div");
    this.finalPrimaryLine.className =
      "caption-primary";

    this.finalOriginalLine =
      document.createElement("div");
    this.finalOriginalLine.className =
      "caption-original";

    this.finalLine.append(
      this.finalPrimaryLine,
      this.finalOriginalLine,
    );

    this.interimLine =
      document.createElement("div");
    this.interimLine.className =
      "caption-line caption-interim is-empty";

    this.interimPrimaryLine =
      document.createElement("div");
    this.interimPrimaryLine.className =
      "caption-primary caption-interim-primary";

    this.interimOriginalLine =
      document.createElement("div");
    this.interimOriginalLine.className =
      "caption-original caption-interim-original";

    this.interimLine.append(
      this.interimPrimaryLine,
      this.interimOriginalLine,
    );

    this.captionStack.append(
      this.translationBadge,
      this.finalLine,
      this.interimLine,
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

    this.cancelFinalFade();
    this.captionBarEnabled = false;
    this.finalId = null;
    this.finalEnglishText = "";
    this.finalJapaneseText = "";
    this.finalPrimaryLine.textContent = "";
    this.finalOriginalLine.textContent = "";
    this.clearInterimCaption();
    this.finalLine.classList.remove(
      "is-fading",
    );
    this.finalLine.classList.add(
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
    this.renderFinalCaption();
    this.renderInterimCaption();
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
    this.cancelFinalFade();

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
    this.host.remove();

    console.log("[overlay]", "overlay destroyed");
  }

  private showFinalCaption(
    line: CaptionLine,
    text: string,
    ja: string,
  ): void {
    const highestFinalId =
      this.highestFinalId;

    if (
      highestFinalId !== null &&
      line.id < highestFinalId
    ) {
      this.refreshFinalFadeIfVisible();
      return;
    }

    if (
      highestFinalId === line.id &&
      this.finalId !== line.id
    ) {
      return;
    }

    if (text === "") {
      this.refreshFinalFadeIfVisible();
      return;
    }

    const isNewFinal =
      highestFinalId === null ||
      line.id > highestFinalId;

    this.captionBarEnabled = true;
    this.cancelFinalFade();

    if (isNewFinal) {
      this.highestFinalId = line.id;
      this.finalId = line.id;
      this.finalEnglishText = text;
      this.finalJapaneseText = "";
    } else {
      this.finalEnglishText = text;
    }

    if (ja !== "") {
      this.finalJapaneseText = ja;
    }

    if (
      this.interimId === line.id ||
      (
        this.interimId !== null &&
        this.interimId <= line.id
      )
    ) {
      this.clearInterimCaption();
    }

    this.renderFinalCaption();
    this.scheduleFinalFade();
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
      this.refreshFinalFadeIfVisible();
      return;
    }

    if (text === "") {
      this.refreshFinalFadeIfVisible();
      return;
    }

    if (
      this.interimId === null ||
      line.id > this.interimId
    ) {
      this.beginInterimCaption(line.id);
    }

    if (ja === "") {
      if (
        !this.shouldAdvanceInterimSnapshot(
          line.at,
          text,
        )
      ) {
        this.refreshFinalFadeIfVisible();
        return;
      }

      this.advanceInterimSnapshot(
        line.at,
        text,
      );
    } else {
      if (
        !this.matchOrAdvanceTranslatedInterim(
          line.at,
          text,
        )
      ) {
        this.refreshFinalFadeIfVisible();
        return;
      }

      this.interimJapaneseText = ja;
      this.interimJapaneseVersion =
        this.interimSnapshotVersion;
    }

    this.captionBarEnabled = true;
    this.renderInterimCaption();
    this.refreshFinalFadeIfVisible();
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

  private renderFinalCaption(): void {
    if (this.finalId === null) {
      this.finalPrimaryLine.textContent = "";
      this.finalOriginalLine.textContent = "";
      this.finalLine.classList.add(
        "is-empty",
      );
      return;
    }

    const useEnglishFallback =
      this.translationPath === "none";

    if (useEnglishFallback) {
      this.finalPrimaryLine.textContent =
        clampCaptionTail(
          this.finalEnglishText,
          MAX_SECONDARY_CAPTION_CHARS,
        );
      this.finalOriginalLine.textContent =
        "";
    } else if (
      this.finalJapaneseText !== ""
    ) {
      this.finalPrimaryLine.textContent =
        clampCaptionTail(
          this.finalJapaneseText,
          MAX_PRIMARY_CAPTION_CHARS,
        );
      this.finalOriginalLine.textContent =
        this.showOriginal
          ? clampCaptionTail(
              this.finalEnglishText,
              MAX_SECONDARY_CAPTION_CHARS,
            )
          : "";
    } else if (this.showOriginal) {
      this.finalPrimaryLine.textContent =
        clampCaptionTail(
          this.finalEnglishText,
          MAX_SECONDARY_CAPTION_CHARS,
        );
      this.finalOriginalLine.textContent =
        "";
    } else {
      this.finalPrimaryLine.textContent = "";
      this.finalOriginalLine.textContent = "";
    }

    this.finalLine.classList.toggle(
      "is-empty",
      this.finalPrimaryLine.textContent === "",
    );
  }

  private renderInterimCaption(): void {
    if (this.interimId === null) {
      this.interimPrimaryLine.textContent = "";
      this.interimOriginalLine.textContent = "";
      this.interimLine.classList.remove(
        "has-translation",
      );
      this.interimLine.classList.add(
        "is-empty",
      );
      return;
    }

    const useEnglishFallback =
      this.translationPath === "none";
    const showTranslated =
      !useEnglishFallback &&
      this.interimJapaneseText !== "";

    if (useEnglishFallback) {
      this.interimPrimaryLine.textContent =
        clampCaptionTail(
          this.interimEnglishText,
          MAX_SECONDARY_CAPTION_CHARS,
        );
      this.interimOriginalLine.textContent =
        "";
    } else if (showTranslated) {
      this.interimPrimaryLine.textContent =
        clampCaptionTail(
          this.interimJapaneseText,
          MAX_PRIMARY_CAPTION_CHARS,
        );
      this.interimOriginalLine.textContent =
        this.showOriginal
          ? clampCaptionTail(
              this.interimEnglishText,
              MAX_SECONDARY_CAPTION_CHARS,
            )
          : "";
    } else if (this.showOriginal) {
      this.interimPrimaryLine.textContent =
        clampCaptionTail(
          this.interimEnglishText,
          MAX_SECONDARY_CAPTION_CHARS,
        );
      this.interimOriginalLine.textContent =
        "";
    } else {
      this.interimPrimaryLine.textContent = "";
      this.interimOriginalLine.textContent = "";
    }

    this.interimLine.classList.toggle(
      "has-translation",
      showTranslated,
    );
    this.interimLine.classList.toggle(
      "is-empty",
      this.interimPrimaryLine.textContent === "",
    );
  }

  private clearInterimCaption(): void {
    this.interimId = null;
    this.interimEnglishText = "";
    this.interimJapaneseText = "";
    this.interimEnglishAt = null;
    this.interimSnapshotVersion = 0;
    this.interimJapaneseVersion = null;
    this.interimPrimaryLine.textContent = "";
    this.interimOriginalLine.textContent = "";
    this.interimLine.classList.remove(
      "has-translation",
    );
    this.interimLine.classList.add(
      "is-empty",
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
      this.updateLayout();
      this.frameId =
        requestAnimationFrame(this.runFrame);
    };

  private startFrameLoop(): void {
    if (
      this.destroyed ||
      this.frameId !== null ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    this.frameId =
      requestAnimationFrame(this.runFrame);
  }

  private appendHost(): void {
    if (this.destroyed) {
      return;
    }

    const parent =
      document.fullscreenElement ??
      document.body ??
      document.documentElement;

    if (this.host.parentNode !== parent) {
      parent.append(this.host);
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

    for (const [video, badge] of this.otherBadges) {
      if (desired.has(video)) {
        continue;
      }

      this.resizeObserver.unobserve(video);
      badge.remove();
      this.otherBadges.delete(video);
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

  private updateLayout(): void {
    if (this.destroyed) {
      return;
    }

    const target = this.targetVideo;

    if (target === null) {
      this.captionStack.style.display =
        "none";
      this.targetChip.style.display =
        "none";
      this.hideOtherBadges();
      return;
    }

    const rect =
      target.getBoundingClientRect();
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

    this.positionOtherBadges();
  }

  private positionCaptionStack(
    rect: DOMRect,
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
    const barHeight = Math.max(
      64,
      Math.min(150, rect.height * 0.26),
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
      Math.min(10, barHeight * 0.07),
    );
    const availableRowHeight = Math.max(
      1,
      barHeight - verticalPadding * 2,
    );

    const originalRowsInFontUnits =
      this.showOriginal
        ? FINAL_ORIGINAL_FONT_SCALE *
            FINAL_ORIGINAL_LINE_HEIGHT +
          INTERIM_ORIGINAL_FONT_SCALE *
            INTERIM_ORIGINAL_LINE_HEIGHT
        : 0;

    const rowHeightInFontUnits =
      FINAL_PRIMARY_LINE_HEIGHT * 2 +
      INTERIM_PRIMARY_FONT_SCALE *
        INTERIM_PRIMARY_LINE_HEIGHT +
      originalRowsInFontUnits;

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

    const finalPrimarySlot =
      fontSize *
      FINAL_PRIMARY_LINE_HEIGHT *
      2;
    const finalOriginalSlot =
      this.showOriginal
        ? fontSize *
          FINAL_ORIGINAL_FONT_SCALE *
          FINAL_ORIGINAL_LINE_HEIGHT
        : 0;
    const interimPrimarySlot =
      fontSize *
      INTERIM_PRIMARY_FONT_SCALE *
      INTERIM_PRIMARY_LINE_HEIGHT;
    const interimOriginalSlot =
      this.showOriginal
        ? fontSize *
          INTERIM_ORIGINAL_FONT_SCALE *
          INTERIM_ORIGINAL_LINE_HEIGHT
        : 0;

    this.captionStack.style.display =
      "flex";
    this.captionStack.style.left =
      `${rect.left}px`;
    this.captionStack.style.bottom =
      `${window.innerHeight - rect.bottom}px`;
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
      "--final-primary-slot",
      `${finalPrimarySlot}px`,
    );
    this.captionStack.style.setProperty(
      "--final-original-slot",
      `${finalOriginalSlot}px`,
    );
    this.captionStack.style.setProperty(
      "--interim-primary-slot",
      `${interimPrimarySlot}px`,
    );
    this.captionStack.style.setProperty(
      "--interim-original-slot",
      `${interimOriginalSlot}px`,
    );
  }

  private positionTargetChip(
    rect: DOMRect,
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

  private positionOtherBadges(): void {
    const captureIsOn =
      this.status === "loadingModel" ||
      this.status === "running";

    if (!captureIsOn) {
      this.hideOtherBadges();
      return;
    }

    for (const [video, badge] of this.otherBadges) {
      if (
        video === this.targetVideo ||
        video.muted ||
        !video.isConnected
      ) {
        badge.style.display = "none";
        continue;
      }

      const rect =
        video.getBoundingClientRect();

      if (!isRectVisible(rect)) {
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

  private hasFinalCaption(): boolean {
    return (
      this.finalPrimaryLine.textContent !== ""
    );
  }

  private refreshFinalFadeIfVisible(): void {
    if (
      this.finalId === null ||
      !this.hasFinalCaption()
    ) {
      return;
    }

    this.cancelFinalFade();
    this.scheduleFinalFade();
  }

  private scheduleFinalFade(): void {
    if (
      this.destroyed ||
      this.finalId === null ||
      this.finalFadeTimerId !== null ||
      this.finalRemovalTimerId !== null
    ) {
      return;
    }

    const expiringId = this.finalId;

    this.finalFadeTimerId =
      window.setTimeout(() => {
        this.finalFadeTimerId = null;

        if (this.finalId !== expiringId) {
          return;
        }

        this.finalLine.classList.add(
          "is-fading",
        );

        this.finalRemovalTimerId =
          window.setTimeout(() => {
            this.finalRemovalTimerId = null;

            if (this.finalId !== expiringId) {
              return;
            }

            this.finalId = null;
            this.finalEnglishText = "";
            this.finalJapaneseText = "";
            this.finalPrimaryLine.textContent =
              "";
            this.finalOriginalLine.textContent =
              "";
            this.finalLine.classList.remove(
              "is-fading",
            );
            this.finalLine.classList.add(
              "is-empty",
            );
            this.updateLayout();
            this.options.onCaptionFadeOut?.();
          }, FINAL_FADE_MS);
      }, FINAL_VISIBLE_MS);
  }

  private cancelFinalFade(): void {
    if (this.finalFadeTimerId !== null) {
      globalThis.clearTimeout(
        this.finalFadeTimerId,
      );
      this.finalFadeTimerId = null;
    }

    if (this.finalRemovalTimerId !== null) {
      globalThis.clearTimeout(
        this.finalRemovalTimerId,
      );
      this.finalRemovalTimerId = null;
    }

    this.finalLine.classList.remove(
      "is-fading",
    );
  }
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
  rect: DOMRect,
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
      --final-primary-slot: 40px;
      --final-original-slot: 0px;
      --interim-primary-slot: 14px;
      --interim-original-slot: 0px;

      position: fixed;
      display: none;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
      margin: 0;
      padding:
        var(--bar-padding-y)
        var(--bar-padding-x);
      overflow: hidden;
      border-radius: 8px 8px 0 0;
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
      margin: 0;
      padding: 0;
      overflow: hidden;
      pointer-events: none;
      opacity: 1;
      transition:
        opacity ${FINAL_FADE_MS}ms ease;
    }

    .caption-line.is-empty {
      opacity: 0;
    }

    .caption-final {
      height: calc(
        var(--final-primary-slot) +
        var(--final-original-slot)
      );
      color: #ffffff;
      font-style: normal;
      font-weight: 650;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.95),
        0 0 3px rgba(0, 0, 0, 0.8);
    }

    .caption-final.is-fading {
      opacity: 0;
    }

    .caption-final > .caption-primary {
      display: -webkit-box;
      flex: 0 0 var(--final-primary-slot);
      width: 100%;
      min-width: 0;
      height: var(--final-primary-slot);
      min-height: var(--final-primary-slot);
      max-height: var(--final-primary-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      overflow-wrap: anywhere;
      font-size: 1em;
      font-weight: 650;
      line-height: ${FINAL_PRIMARY_LINE_HEIGHT};
      white-space: normal;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }

    .caption-final > .caption-original {
      display: block;
      flex: 0 0 var(--final-original-slot);
      width: 100%;
      min-width: 0;
      height: var(--final-original-slot);
      min-height: var(--final-original-slot);
      max-height: var(--final-original-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: rgba(229, 231, 235, 0.78);
      font-size: ${FINAL_ORIGINAL_FONT_SCALE}em;
      font-weight: 500;
      line-height: ${FINAL_ORIGINAL_LINE_HEIGHT};
      text-overflow: ellipsis;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.9);
      white-space: nowrap;
    }

    .caption-interim {
      height: calc(
        var(--interim-primary-slot) +
        var(--interim-original-slot)
      );
      color: rgba(229, 231, 235, 0.88);
      font-style: italic;
      font-weight: 500;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.9);
    }

    .caption-interim > .caption-interim-primary {
      display: block;
      flex: 0 0 var(--interim-primary-slot);
      width: 100%;
      min-width: 0;
      height: var(--interim-primary-slot);
      min-height: var(--interim-primary-slot);
      max-height: var(--interim-primary-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: rgba(229, 231, 235, 0.88);
      font-size: ${INTERIM_PRIMARY_FONT_SCALE}em;
      font-weight: 500;
      line-height: ${INTERIM_PRIMARY_LINE_HEIGHT};
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .caption-interim.has-translation
      > .caption-interim-primary {
      color: rgba(243, 244, 246, 0.94);
      font-weight: 550;
    }

    .caption-interim > .caption-interim-original {
      display: block;
      flex: 0 0 var(--interim-original-slot);
      width: 100%;
      min-width: 0;
      height: var(--interim-original-slot);
      min-height: var(--interim-original-slot);
      max-height: var(--interim-original-slot);
      margin: 0;
      padding: 0;
      overflow: hidden;
      color: rgba(209, 213, 219, 0.66);
      font-size: ${INTERIM_ORIGINAL_FONT_SCALE}em;
      font-weight: 450;
      line-height: ${INTERIM_ORIGINAL_LINE_HEIGHT};
      text-overflow: ellipsis;
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
