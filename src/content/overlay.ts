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
}

export type CaptionOverlayStatus =
  | "loadingModel"
  | "running"
  | "error";

export interface CaptionOverlayOptions {
  getTargetVideo(): HTMLVideoElement | null;
  onCaptionFadeOut?(): void;
}

export class CaptionOverlay {
  private readonly options: CaptionOverlayOptions;
  private readonly host: HTMLDivElement;
  private readonly captionStack: HTMLDivElement;
  private readonly finalLine: HTMLDivElement;
  private readonly interimLine: HTMLDivElement;
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
  private progress: number | undefined;
  private finalId: number | null = null;
  private interimId: number | null = null;
  private frameId: number | null = null;
  private mutationTimerId: number | null =
    null;
  private finalFadeTimerId: number | null =
    null;
  private finalRemovalTimerId: number | null =
    null;
  private destroyed = false;

  constructor(options: CaptionOverlayOptions) {
    this.options = options;

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

    this.finalLine =
      document.createElement("div");
    this.finalLine.className =
      "caption-line caption-final";

    this.interimLine =
      document.createElement("div");
    this.interimLine.className =
      "caption-line caption-interim";

    this.captionStack.append(
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

    this.updateTargetChip();
    this.appendHost();
    this.observeMutationRoot();
    this.installEventListeners();
    this.refreshTarget();
    this.refreshOtherVideos();
    this.startFrameLoop();

    console.log("[overlay]", "overlay created");
  }

  showCaption(line: CaptionLine): void {
    if (this.destroyed) {
      return;
    }

    const text = line.text.trim();

    this.cancelFinalFade();

    if (line.final) {
      if (
        this.interimId === line.id ||
        this.interimLine.textContent !== ""
      ) {
        this.interimId = null;
        this.interimLine.textContent = "";
      }

      if (text === "") {
        this.updateLayout();
        return;
      }

      this.finalId = line.id;
      this.finalLine.textContent = text;
      this.finalLine.classList.remove(
        "is-fading",
      );
      this.scheduleFinalFade();
    } else {
      this.interimId = line.id;
      this.interimLine.textContent = text;

      if (
        this.finalLine.textContent !== ""
      ) {
        this.scheduleFinalFade();
      }
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
    this.finalId = null;
    this.interimId = null;
    this.finalLine.textContent = "";
    this.interimLine.textContent = "";
    this.finalLine.classList.remove(
      "is-fading",
    );
    this.captionStack.style.display = "none";

    console.log("[overlay]", "captions cleared");
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
    const hasCaption =
      this.finalLine.textContent !== "" ||
      this.interimLine.textContent !== "";

    if (!hasCaption) {
      this.captionStack.style.display =
        "none";
      return;
    }

    const horizontalPadding = Math.max(
      10,
      Math.min(32, rect.width * 0.035),
    );
    const bottomInset = Math.max(
      8,
      Math.min(24, rect.height * 0.04),
    );
    const width = Math.max(
      0,
      rect.width -
        horizontalPadding * 2,
    );
    const fontSize = Math.max(
      14,
      Math.min(24, rect.width / 32),
    );

    if (width <= 0) {
      this.captionStack.style.display =
        "none";
      return;
    }

    this.captionStack.style.display =
      "flex";
    this.captionStack.style.left =
      `${rect.left + horizontalPadding}px`;
    this.captionStack.style.bottom =
      `${Math.max(
        0,
        window.innerHeight -
          rect.bottom +
          bottomInset,
      )}px`;
    this.captionStack.style.width =
      `${width}px`;
    this.captionStack.style.maxWidth =
      `${width}px`;
    this.captionStack.style.fontSize =
      `${fontSize}px`;
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

  private scheduleFinalFade(): void {
    if (
      this.destroyed ||
      this.finalLine.textContent === ""
    ) {
      return;
    }

    this.finalFadeTimerId =
      window.setTimeout(() => {
        this.finalFadeTimerId = null;
        this.finalLine.classList.add(
          "is-fading",
        );

        this.finalRemovalTimerId =
          window.setTimeout(() => {
            this.finalRemovalTimerId = null;
            this.finalId = null;
            this.finalLine.textContent = "";
            this.finalLine.classList.remove(
              "is-fading",
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
      position: fixed;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: 4px;
      margin: 0;
      padding: 0;
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      line-height: 1.28;
      text-align: center;
      pointer-events: none;
    }

    .caption-line {
      display: block;
      width: fit-content;
      max-width: 100%;
      margin: 0 auto;
      padding: 0.18em 0.48em 0.22em;
      border-radius: 0.2em;
      overflow-wrap: anywhere;
      white-space: normal;
      pointer-events: none;
      transition: opacity ${FINAL_FADE_MS}ms ease;
    }

    .caption-line:empty {
      display: none;
    }

    .caption-final {
      color: #ffffff;
      background: rgba(0, 0, 0, 0.72);
      font-style: normal;
      font-weight: 650;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.95),
        0 0 3px rgba(0, 0, 0, 0.8);
      opacity: 1;
    }

    .caption-final.is-fading {
      opacity: 0;
    }

    .caption-interim {
      color: #d1d5db;
      background: rgba(0, 0, 0, 0.5);
      font-style: italic;
      font-weight: 500;
      text-shadow:
        0 1px 2px rgba(0, 0, 0, 0.9);
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
