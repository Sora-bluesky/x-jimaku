// @vitest-environment jsdom

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CaptionOverlay,
  CUE_MINIMUM_DISPLAY_MS,
} from "./overlay";

class ResizeObserverStub {
  observe(): void {
  }

  unobserve(): void {
  }

  disconnect(): void {
  }
}

let activeOverlay:
  | CaptionOverlay
  | null = null;

function createOverlay(): CaptionOverlay {
  const overlay = new CaptionOverlay({
    getTargetVideo: () => null,
    showOriginal: false,
    onCaptionFadeOut: () => {
    },
  });

  activeOverlay = overlay;
  overlay.setStatus("running");

  return overlay;
}

function requireElement<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element =
    root.querySelector<T>(selector);

  if (element === null) {
    throw new Error(
      `Expected element matching ${selector}`,
    );
  }

  return element;
}

function getOverlayDom(): {
  captionStack: HTMLDivElement;
  cueContainer: HTMLDivElement;
} {
  const host =
    requireElement<HTMLDivElement>(
      document,
      "#xjsub-host",
    );

  expect(host.isConnected).toBe(true);

  const shadow = host.shadowRoot;

  if (shadow === null) {
    throw new Error(
      "Expected overlay shadow root",
    );
  }

  return {
    captionStack:
      requireElement<HTMLDivElement>(
        shadow,
        ".caption-stack",
      ),
    cueContainer:
      requireElement<HTMLDivElement>(
        shadow,
        ".cue-container",
      ),
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    ResizeObserverStub,
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((): number => 1),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((_frameId: number): void => {
    }),
  );
});

afterEach(() => {
  activeOverlay?.destroy();
  activeOverlay = null;
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe(
  "CaptionOverlay pending finals",
  () => {
    it(
      "holds a raw final until the same id arrives with ja",
      () => {
        const overlay = createOverlay();

        overlay.setTranslationPath(
          "language-model",
        );
        overlay.showCaption({
          id: 1,
          text: "Raw caption",
          final: true,
          at: "2026-08-28T00:00:00.000Z",
        });

        const {
          captionStack,
          cueContainer,
        } = getOverlayDom();

        expect(
          cueContainer.textContent,
        ).toBe("");
        expect(
          captionStack.textContent,
        ).not.toContain("Raw caption");
        expect(
          cueContainer.querySelector(
            ".caption-cue",
          ),
        ).toBeNull();

        overlay.showCaption({
          id: 1,
          text: "Raw caption",
          ja: "日本語字幕",
          final: true,
          at: "2026-08-28T00:00:00.001Z",
        });

        expect(
          cueContainer.textContent,
        ).toBe("日本語字幕");
        expect(
          captionStack.textContent,
        ).toContain("日本語字幕");
        expect(
          requireElement<HTMLDivElement>(
            cueContainer,
            ".caption-cue",
          ).dataset.cueId,
        ).toBe("1:0");
      },
    );

    it(
      "renders a pending raw final when translation becomes none",
      () => {
        const overlay = createOverlay();

        overlay.setTranslationPath(
          "language-model",
        );
        overlay.showCaption({
          id: 2,
          text: "Original caption",
          final: true,
          at: "2026-08-28T00:00:01.000Z",
        });

        const {
          captionStack,
          cueContainer,
        } = getOverlayDom();

        expect(
          cueContainer.textContent,
        ).toBe("");
        expect(
          captionStack.textContent,
        ).not.toContain(
          "Original caption",
        );

        overlay.setTranslationPath("none");

        expect(
          cueContainer.textContent,
        ).toBe("Original caption");
        expect(
          captionStack.textContent,
        ).toContain(
          "Original caption",
        );
        expect(
          requireElement<HTMLDivElement>(
            cueContainer,
            ".caption-cue",
          ).dataset.cueId,
        ).toBe("2:0");
      },
    );

    it(
      "ignores replayed accepted final ids without duplicating or reordering cues",
      () => {
        const overlay = createOverlay();

        overlay.setTranslationPath(
          "language-model",
        );
        overlay.showCaption({
          id: 30,
          text: "First raw caption",
          ja: "最初の字幕",
          final: true,
          at: "2026-08-28T00:00:02.000Z",
        });

        overlay.showCaption({
          id: 30,
          text: "First raw caption",
          final: true,
          at: "2026-08-28T00:00:02.001Z",
        });
        overlay.showCaption({
          id: 30,
          text: "First raw caption",
          ja: "変更された字幕",
          final: true,
          at: "2026-08-28T00:00:02.002Z",
        });
        overlay.showCaption({
          id: 31,
          text: "Second raw caption",
          ja: "次の字幕",
          final: true,
          at: "2026-08-28T00:00:03.000Z",
        });

        const {
          cueContainer,
        } = getOverlayDom();

        expect(
          cueContainer.querySelectorAll(
            ".caption-cue",
          ),
        ).toHaveLength(1);
        expect(
          cueContainer.textContent,
        ).toBe("最初の字幕");
        expect(
          requireElement<HTMLDivElement>(
            cueContainer,
            ".caption-cue",
          ).dataset.cueId,
        ).toBe("30:0");

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(
          cueContainer.querySelectorAll(
            ".caption-cue",
          ),
        ).toHaveLength(1);
        expect(
          cueContainer.textContent,
        ).toBe("次の字幕");
        expect(
          requireElement<HTMLDivElement>(
            cueContainer,
            ".caption-cue",
          ).dataset.cueId,
        ).toBe("31:0");

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(
          cueContainer.textContent,
        ).toBe("次の字幕");
        expect(
          cueContainer.querySelectorAll(
            ".caption-cue",
          ),
        ).toHaveLength(1);
      },
    );
  },
);
