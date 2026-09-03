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
  CAPTION_FADE_MS,
  CAPTION_VISIBLE_MS,
} from "../shared/explicit-stop-drain";
import {
  INITIALIZATION_PROGRESS_CEILING,
} from "../shared/initialization-progress";
import {
  MAX_LINE_UNITS,
  wrapCueText,
} from "./cue-text";
import {
  CaptionOverlay,
  CUE_ACCELERATED_DISPLAY_MS,
  CUE_MINIMUM_DISPLAY_MS,
} from "./overlay";

const BUILD_STAMP =
  "0.6.0 abc1234-dirty 2026-09-02T03:04:05Z";
const THREE_LINE_TEXT =
  "おネち5ナbた1）6c オネz0と3そ4たく0 2ア pてせ、ぬ c ）、";

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

function createOverlay(
  options: {
    buildStamp?: string;
    showOriginal?: boolean;
    showTentative?: boolean;
    getTargetVideo?: () => HTMLVideoElement | null;
    onCaptionFadeOut?: () => void;
  } = {},
): CaptionOverlay {
  const overlay = new CaptionOverlay({
    getTargetVideo:
      options.getTargetVideo ??
      (() => null),
    buildStamp:
      options.buildStamp ?? BUILD_STAMP,
    showOriginal:
      options.showOriginal ?? false,
    showTentative:
      options.showTentative ?? false,
    onCaptionFadeOut:
      options.onCaptionFadeOut ??
      (() => {
      }),
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
  host: HTMLDivElement;
  captionStack: HTMLDivElement;
  cueContainer: HTMLDivElement;
  captionLedger: HTMLDivElement;
  tentativeLine: HTMLDivElement;
  targetChip: HTMLDivElement;
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
    host,
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
    captionLedger:
      requireElement<HTMLDivElement>(
        shadow,
        ".caption-ledger",
      ),
    tentativeLine:
      requireElement<HTMLDivElement>(
        shadow,
        ".caption-tentative",
      ),
    targetChip:
      requireElement<HTMLDivElement>(
        shadow,
        ".target-chip",
      ),
  };
}

function getBlockLines():
  [string, string] {
  const { cueContainer } =
    getOverlayDom();
  const lines = cueContainer
    .querySelectorAll<HTMLDivElement>(
      ".caption-primary",
    );

  expect(lines).toHaveLength(2);

  return [
    lines[0]?.textContent ?? "",
    lines[1]?.textContent ?? "",
  ];
}

function getPageId(): string | undefined {
  const { cueContainer } =
    getOverlayDom();

  return requireElement<HTMLDivElement>(
    cueContainer,
    ".caption-cue",
  ).dataset.pageId;
}

function getOriginalText(): string {
  return requireElement<HTMLDivElement>(
    getOverlayDom().cueContainer,
    ".caption-original",
  ).textContent ?? "";
}

function getLedgerTexts(): string[] {
  return [
    ...getOverlayDom()
      .captionLedger.children,
  ].map(
    (entry) => entry.textContent ?? "",
  );
}

function getWaitingCues(
  overlay: CaptionOverlay,
): Array<{
  sourceIds: readonly number[];
  primaryText: string;
  fallback?: boolean;
}> {
  return (
    overlay as unknown as {
      waitingCues: Array<{
        sourceIds: readonly number[];
        primaryText: string;
        fallback?: boolean;
      }>;
    }
  ).waitingCues;
}

function expectLinesExactlyOnce(
  pages:
    readonly (
      readonly [string, string]
    )[],
  inputLines: readonly string[],
): void {
  const displayedLines = pages
    .flatMap((page) => page)
    .filter((line) => line !== "");

  expect(displayedLines).toHaveLength(
    inputLines.length,
  );

  for (const inputLine of inputLines) {
    expect(
      displayedLines.filter(
        (line) => line === inputLine,
      ),
    ).toHaveLength(1);
  }
}

function showFinal(
  overlay: CaptionOverlay,
  id: number,
  ja: string,
  text: string = `source-${id}`,
): void {
  overlay.showCaption({
    id,
    text,
    ja,
    final: true,
    at: "2026-09-01T00:00:00.000Z",
  });
}

async function flushCueMutations():
  Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
  "CaptionOverlay initialization status",
  () => {
    it(
      "shows the warmup label at the initialization ceiling",
      () => {
        const overlay = createOverlay();

        overlay.setStatus(
          "loadingModel",
          INITIALIZATION_PROGRESS_CEILING,
        );

        expect(
          getOverlayDom().targetChip.textContent,
        ).toBe(
          "字幕 準備中(ウォームアップ)…",
        );
      },
    );

    it(
      "shows the build stamp in the chip tooltip without changing its label",
      () => {
        const overlay = createOverlay({
          buildStamp: BUILD_STAMP,
        });
        const { targetChip } =
          getOverlayDom();

        expect(
          targetChip.getAttribute("title"),
        ).toBe(BUILD_STAMP);
        expect(
          targetChip.style.pointerEvents,
        ).toBe("auto");
        expect(targetChip.textContent)
          .toBe("字幕ON");
      },
    );
  },
);

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
          cueContainer.querySelectorAll(
            ".caption-cue",
          ),
        ).toHaveLength(1);
        expect(getBlockLines()).toEqual(
          ["", ""],
        );

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

describe(
  "CaptionOverlay page display",
  () => {
    it(
      "renders consecutive one-line clauses as separate pages",
      () => {
        const overlay = createOverlay();
        const pages:
          Array<[string, string]> = [];

        showFinal(overlay, 1, "A");
        pages.push(getBlockLines());

        showFinal(overlay, 2, "B");
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        pages.push(getBlockLines());

        expect(pages).toEqual([
          ["A", ""],
          ["B", ""],
        ]);
        expectLinesExactlyOnce(
          pages,
          ["A", "B"],
        );
      },
    );

    it(
      "renders one wrapped two-line cue as one page",
      () => {
        const overlay = createOverlay();
        const text =
          "alpha beta gamma delta epsilon zeta";
        const inputLines = wrapCueText(
          text,
          MAX_LINE_UNITS,
        ).split("\n");

        expect(inputLines).toHaveLength(2);

        showFinal(overlay, 1, text);

        const pages = [getBlockLines()];

        expect(pages).toEqual([
          [
            inputLines[0] ?? "",
            inputLines[1] ?? "",
          ],
        ]);
        expect(getPageId()).toBe("0");
        expectLinesExactlyOnce(
          pages,
          inputLines,
        );
      },
    );

    it(
      "holds the last block through silence and clears it after fade",
      () => {
        const onCaptionFadeOut = vi.fn();
        const overlay = createOverlay({
          onCaptionFadeOut,
        });

        showFinal(overlay, 1, "A");
        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS - 1,
        );

        expect(getBlockLines()).toEqual(
          ["A", ""],
        );
        expect(
          getOverlayDom()
            .captionStack
            .querySelector(
              ".caption-line",
            )
            ?.classList.contains(
              "is-fading",
            ),
        ).toBe(false);

        vi.advanceTimersByTime(1);
        expect(
          getOverlayDom()
            .captionStack
            .querySelector(
              ".caption-line",
            )
            ?.classList.contains(
              "is-fading",
            ),
        ).toBe(true);

        vi.advanceTimersByTime(
          CAPTION_FADE_MS,
        );
        expect(getBlockLines()).toEqual(
          ["", ""],
        );
        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();
      },
    );

    it(
      "A-6-5 marks the caption stack blank before and after visible text",
      () => {
        const overlay = createOverlay();

        overlay.setTranslationPath(null);

        const { captionStack } =
          getOverlayDom();

        expect(
          captionStack.classList.contains(
            "is-blank",
          ),
        ).toBe(true);

        showFinal(overlay, 1, "A");

        expect(
          captionStack.classList.contains(
            "is-blank",
          ),
        ).toBe(false);

        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS +
            CAPTION_FADE_MS,
        );

        expect(getBlockLines()).toEqual(
          ["", ""],
        );
        expect(
          captionStack.classList.contains(
            "is-blank",
          ),
        ).toBe(true);
      },
    );

    it(
      "renders a three-line cue as two dwell-separated pages",
      () => {
        const overlay = createOverlay();
        const inputLines = wrapCueText(
          THREE_LINE_TEXT,
          MAX_LINE_UNITS,
        ).split("\n");

        expect(inputLines).toHaveLength(3);

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );

        const firstPage = getBlockLines();
        const pages:
          Array<[string, string]> = [
            firstPage,
          ];
        const pageIds = [getPageId()];

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS - 1,
        );

        expect(getBlockLines()).toEqual(
          firstPage,
        );
        expect(getPageId()).toBe("0");

        vi.advanceTimersByTime(1);
        pages.push(getBlockLines());
        pageIds.push(getPageId());

        expect(pages).toEqual([
          [
            inputLines[0] ?? "",
            inputLines[1] ?? "",
          ],
          [
            inputLines[2] ?? "",
            "",
          ],
        ]);
        expect(pageIds).toEqual([
          "0",
          "1",
        ]);
        expectLinesExactlyOnce(
          pages,
          inputLines,
        );
      },
    );

    it(
      "uses accelerated dwell before rendering the second page",
      () => {
        const overlay = createOverlay();
        const inputLines = wrapCueText(
          THREE_LINE_TEXT,
          MAX_LINE_UNITS,
        ).split("\n");

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );
        showFinal(overlay, 2, "queued one");
        showFinal(overlay, 3, "queued two");

        const firstPage = getBlockLines();

        expect(getPageId()).toBe("0");

        vi.advanceTimersByTime(
          CUE_ACCELERATED_DISPLAY_MS - 1,
        );

        expect(getBlockLines()).toEqual(
          firstPage,
        );
        expect(getPageId()).toBe("0");

        vi.advanceTimersByTime(1);

        expect(getBlockLines()).toEqual([
          inputLines[2] ?? "",
          "",
        ]);
        expect(getPageId()).toBe("1");
      },
    );

    it(
      "appends only the new tail when a clause is revised longer",
      () => {
        const overlay = createOverlay({});

        showFinal(
          overlay,
          1,
          "これは途中まで",
          "This is a sentence that",
        );
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        showFinal(
          overlay,
          2,
          "これは途中まで届いた文です。",
          "This is a sentence that arrived.",
        );

        const seen = new Set<string>();
        const step = Math.ceil(
          CUE_MINIMUM_DISPLAY_MS / 10,
        );

        for (
          let elapsed = 0;
          elapsed <=
            CUE_MINIMUM_DISPLAY_MS * 3;
          elapsed += step
        ) {
          for (const slot of getBlockLines()) {
            if (slot !== "") seen.add(slot);
          }

          vi.advanceTimersByTime(step);
        }

        const joined = [...seen].join("|");

        expect(joined).toContain(
          "これは途中まで",
        );
        expect(
          joined.split("これは途中まで")
            .length - 1,
        ).toBe(1);
        expect(joined).toContain(
          "届いた文です。",
        );
      },
    );

    it(
      "shows an unrendered page before drain completion",
      () => {
        const onCaptionFadeOut = vi.fn();
        const overlay = createOverlay({
          onCaptionFadeOut,
        });
        const inputLines = wrapCueText(
          THREE_LINE_TEXT,
          MAX_LINE_UNITS,
        ).split("\n");

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );

        expect(
          overlay.hasPendingCaption(),
        ).toBe(true);

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(getBlockLines()).toEqual([
          inputLines[2] ?? "",
          "",
        ]);
        expect(onCaptionFadeOut)
          .not.toHaveBeenCalled();

        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS +
          CAPTION_FADE_MS,
        );

        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();
        expect(
          overlay.hasPendingCaption(),
        ).toBe(false);
      },
    );

    it(
      "clears displayed, pending, and ledger state for a new capture",
      () => {
        const overlay = createOverlay();

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );
        expect(
          getOverlayDom()
            .captionLedger
            .children.length,
        ).toBe(1);

        overlay.clear();
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(getBlockLines()).toEqual(
          ["", ""],
        );
        expect(
          getOverlayDom()
            .captionLedger
            .children.length,
        ).toBe(0);
        expect(
          overlay.hasPendingCaption(),
        ).toBe(false);
      },
    );

    it(
      "keeps tentative text outside the committed block",
      () => {
        const overlay = createOverlay();

        overlay.showCaption({
          id: 1,
          text: "draft",
          final: false,
          at: "2026-09-01T00:00:00.000Z",
        });

        expect(getBlockLines()).toEqual(
          ["", ""],
        );
        expect(
          getOverlayDom()
            .tentativeLine.textContent,
        ).toBe("draft");

        showFinal(overlay, 1, "確定");

        expect(getBlockLines()).toEqual(
          ["確定", ""],
        );
        expect(
          getOverlayDom()
            .tentativeLine.textContent,
        ).toBe("");
      },
    );

    it(
      "keeps one original line across every page and reconstructs empty",
      () => {
        const overlay = createOverlay({
          showOriginal: true,
        });

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
          "Original",
        );

        const { cueContainer } =
          getOverlayDom();
        const originalLine =
          requireElement<HTMLDivElement>(
            cueContainer,
            ".caption-original",
          );

        expect(
          cueContainer.querySelectorAll(
            ".caption-original",
          ),
        ).toHaveLength(1);
        expect(originalLine.textContent)
          .toBe("Original");

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(getPageId()).toBe("1");
        expect(originalLine.textContent)
          .toBe("Original");

        overlay.destroy();
        createOverlay({
          showOriginal: false,
        });

        expect(getBlockLines()).toEqual(
          ["", ""],
        );
      },
    );

    it(
      "keeps queue drops while paging the retained cues",
      () => {
        const overlay = createOverlay();
        const symbols = [
          "一", "二", "三", "四",
          "五", "六", "七", "八",
        ];

        symbols.forEach(
          (symbol, index) => {
            showFinal(
              overlay,
              index + 1,
              symbol.repeat(14),
            );
          },
        );

        expect(
          getOverlayDom()
            .host.dataset.cueDrops,
        ).toBe("1");

        vi.advanceTimersByTime(1_000);

        expect(
          getOverlayDom()
            .cueContainer
            .querySelector<HTMLElement>(
              ".caption-cue",
            )
            ?.dataset.cueId,
        ).toBe("3:0");
      },
    );

    it(
      "freezes an unrendered page while playback is paused",
      () => {
        const overlay = createOverlay();
        const inputLines = wrapCueText(
          THREE_LINE_TEXT,
          MAX_LINE_UNITS,
        ).split("\n");
        const elapsedBeforePause = 500;

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );
        const firstPage = getBlockLines();

        vi.advanceTimersByTime(
          elapsedBeforePause,
        );
        overlay.setPlaybackPaused(true);
        vi.advanceTimersByTime(1_000);

        expect(getBlockLines()).toEqual(
          firstPage,
        );
        expect(getPageId()).toBe("0");

        overlay.setPlaybackPaused(false);
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS -
            elapsedBeforePause -
            1,
        );

        expect(getBlockLines()).toEqual(
          firstPage,
        );
        expect(getPageId()).toBe("0");

        vi.advanceTimersByTime(1);

        expect(getBlockLines()).toEqual([
          inputLines[2] ?? "",
          "",
        ]);
        expect(getPageId()).toBe("1");
      },
    );

    it(
      "A-6-4(a) waits for the remaining page and fade before completing drain",
      () => {
        const onCaptionFadeOut = vi.fn();
        const overlay = createOverlay({
          onCaptionFadeOut,
        });

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );
        overlay.beginDrain();

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS - 1,
        );
        expect(getPageId()).toBe("0");
        expect(onCaptionFadeOut)
          .not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(getPageId()).toBe("1");
        expect(onCaptionFadeOut)
          .not.toHaveBeenCalled();

        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS +
          CAPTION_FADE_MS,
        );
        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();
        expect(
          overlay.hasPendingCaption(),
        ).toBe(false);
      },
    );

    it(
      "A-6-4(b) waits for fallback and normalizes both none arrival orders",
      () => {
        for (
          const order of [
            "fallback-first",
            "none-first",
          ] as const
        ) {
          const onCaptionFadeOut = vi.fn();
          const overlay = createOverlay({
            showOriginal: true,
            onCaptionFadeOut,
          });

          overlay.setTranslationPath(
            "language-model",
          );
          overlay.showCaption({
            id: 40,
            text: "Original caption",
            final: true,
            at: "2026-09-02T00:00:00.000Z",
          });
          overlay.beginDrain();

          expect(onCaptionFadeOut)
            .not.toHaveBeenCalled();
          expect(
            overlay.hasPendingCaption(),
          ).toBe(true);

          const fallback = {
            id: 40,
            text: "Original caption",
            ja: "Original caption",
            fallback: true,
            final: true,
            at: "2026-09-02T00:00:00.001Z",
          };

          if (order === "none-first") {
            overlay.setTranslationPath(
              "none",
            );
            overlay.showCaption(fallback);
          } else {
            overlay.showCaption(fallback);
            overlay.setTranslationPath(
              "none",
            );
          }

          expect(getBlockLines()).toEqual([
            "Original caption",
            "",
          ]);
          expect(getOriginalText()).toBe("");
          expect(getLedgerTexts()).toEqual([
            "Original caption",
          ]);

          vi.advanceTimersByTime(
            CAPTION_VISIBLE_MS +
            CAPTION_FADE_MS,
          );
          expect(onCaptionFadeOut)
            .toHaveBeenCalledOnce();

          overlay.destroy();
        }
      },
    );

    it(
      "A-6-4(b) completes drain immediately when only an empty revision remains",
      () => {
        const onCaptionFadeOut = vi.fn();
        const overlay = createOverlay({
          onCaptionFadeOut,
        });

        overlay.setTranslationPath(
          "language-model",
        );
        showFinal(
          overlay,
          1,
          "同じ訳",
          "same source",
        );

        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS +
            CAPTION_FADE_MS,
        );
        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();
        onCaptionFadeOut.mockClear();

        overlay.showCaption({
          id: 2,
          text: "same source",
          final: true,
          at: "2026-09-02T00:00:00.001Z",
        });
        overlay.beginDrain();

        expect(
          overlay.hasPendingCaption(),
        ).toBe(true);
        expect(onCaptionFadeOut)
          .not.toHaveBeenCalled();

        overlay.showCaption({
          id: 2,
          text: "same source",
          ja: "同じ訳",
          final: true,
          at: "2026-09-02T00:00:00.002Z",
        });

        expect(
          overlay.hasPendingCaption(),
        ).toBe(false);
        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();

        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS +
            CAPTION_FADE_MS,
        );
        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();
      },
    );

    it(
      "A-6-4(b''''') uses source watermark and keeps fallback queue kinds separate",
      () => {
        const overlay = createOverlay({
          showOriginal: true,
        });
        overlay.setTranslationPath(
          "language-model",
        );

        overlay.showCaption({
          id: 1,
          text: "A B",
          ja: "ja1",
          final: true,
          at: "2026-09-02T00:00:01.000Z",
        });
        overlay.showCaption({
          id: 2,
          text: "A B C D",
          ja: "A B C D",
          fallback: true,
          final: true,
          at: "2026-09-02T00:00:02.000Z",
        });
        overlay.showCaption({
          id: 3,
          text: "A B C D E F",
          ja: "ja3",
          final: true,
          at: "2026-09-02T00:00:03.000Z",
        });

        expect(getBlockLines()).toEqual([
          "ja1",
          "",
        ]);
        expect(getOriginalText()).toBe(
          "A B",
        );
        expect(getLedgerTexts()).toEqual([
          "ja1",
          "C D",
          "E F",
        ]);

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        expect(getBlockLines()).toEqual([
          "C D",
          "",
        ]);
        expect(getOriginalText()).toBe("");

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        expect(getBlockLines()).toEqual([
          "E F",
          "",
        ]);
        expect(getOriginalText()).toBe("");

        overlay.destroy();
        const queued = createOverlay();
        showFinal(
          queued,
          10,
          "active",
          "root",
        );
        showFinal(
          queued,
          11,
          "日本語",
          "base",
        );

        let source = "base";

        for (
          let id = 12;
          id <= 19;
          id += 1
        ) {
          source += String
            .fromCharCode(96 + id)
            .repeat(14);
          queued.showCaption({
            id,
            text: source,
            ja: source,
            fallback: true,
            final: true,
            at:
              `2026-09-02T00:00:${id}.000Z`,
          });

          if (id === 12) {
            expect(
              getWaitingCues(queued)
                .slice(0, 2)
                .map((cue) => ({
                  ids: cue.sourceIds,
                  fallback: cue.fallback,
                })),
            ).toEqual([
              {
                ids: [11],
                fallback: false,
              },
              {
                ids: [12],
                fallback: true,
              },
            ]);
          }
        }

        expect(
          getWaitingCues(queued).length,
        ).toBeLessThanOrEqual(6);
      },
    );

    it(
      "A-6-4(b''''') keeps translated source diffs separate from waiting Japanese cues under pressure",
      () => {
        const overlay = createOverlay();
        overlay.setTranslationPath(
          "language-model",
        );

        showFinal(
          overlay,
          1,
          "active",
          "root",
        );
        showFinal(
          overlay,
          2,
          "日本語",
          "base",
        );

        let source = "base";

        for (
          let id = 3;
          id <= 17;
          id += 2
        ) {
          overlay.showCaption({
            id,
            text: source,
            ja: source,
            fallback: true,
            final: true,
            at:
              `2026-09-02T00:00:${id}.000Z`,
          });

          const sourceDiff = String
            .fromCharCode(96 + id)
            .repeat(14);
          source += sourceDiff;

          overlay.showCaption({
            id: id + 1,
            text: source,
            ja: `訳-${id + 1}`,
            final: true,
            at:
              `2026-09-02T00:00:${id + 1}.000Z`,
          });

          if (id === 3) {
            expect(
              getWaitingCues(overlay),
            ).toMatchObject([
              {
                sourceIds: [2],
                primaryText: "日本語",
                fallback: false,
              },
              {
                sourceIds: [4],
                primaryText:
                  "c".repeat(14),
                fallback: true,
              },
            ]);
          }
        }

        const waiting =
          getWaitingCues(overlay);

        expect(getLedgerTexts())
          .toHaveLength(10);
        expect(waiting.length)
          .toBeLessThanOrEqual(6);
        expect(
          waiting.find((cue) =>
            cue.sourceIds.includes(2)
          )?.sourceIds,
        ).toEqual([2]);
        expect(
          waiting.filter(
            (cue) =>
              cue.sourceIds.includes(2) &&
              cue.sourceIds.some(
                (id) => id !== 2,
              ),
          ),
        ).toEqual([]);
      },
    );

    it(
      "A-6-4(c) pauses outside drain and keeps the clock running during drain",
      () => {
        let overlay: CaptionOverlay;
        const onCaptionFadeOut = vi.fn(
          () => overlay.endDrain(),
        );
        overlay = createOverlay({
          onCaptionFadeOut,
        });

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
        );
        const firstPage = getBlockLines();

        vi.advanceTimersByTime(500);
        overlay.setPlaybackPaused(true);
        vi.advanceTimersByTime(1_000);

        expect(getBlockLines()).toEqual(
          firstPage,
        );

        overlay.beginDrain();
        overlay.setPlaybackPaused(true);
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS - 500,
        );

        expect(getPageId()).toBe("1");

        vi.advanceTimersByTime(
          CAPTION_VISIBLE_MS +
          CAPTION_FADE_MS,
        );
        expect(onCaptionFadeOut)
          .toHaveBeenCalledOnce();

        showFinal(
          overlay,
          2,
          THREE_LINE_TEXT,
        );
        overlay.setPlaybackPaused(true);
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(getPageId()).toBe("0");
      },
    );

    it(
      "allows intended page writes but reports a direct text rewrite",
      async () => {
        const overlay = createOverlay({
          showOriginal: true,
        });

        showFinal(
          overlay,
          1,
          THREE_LINE_TEXT,
          "Original",
        );
        await flushCueMutations();

        const {
          host,
          cueContainer,
        } = getOverlayDom();

        expect(
          host.dataset.cueMutations,
        ).toBe("0");

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        await flushCueMutations();

        expect(
          host.dataset.cueMutations,
        ).toBe("0");
        expect(getPageId()).toBe("1");

        requireElement<HTMLDivElement>(
          cueContainer,
          ".caption-original",
        ).textContent = "Rewritten";
        await flushCueMutations();

        expect(
          host.dataset.cueMutations,
        ).toBe("1");
      },
    );
  },
);

function createLaidOutOverlay(
  options: {
    showOriginal?: boolean;
    showTentative?: boolean;
  } = {},
): CaptionOverlay {
  const video = document.createElement(
    "video",
  );
  video.getBoundingClientRect = () =>
    new DOMRect(0, 0, 960, 540);
  document.body.append(video);

  return createOverlay({
    ...options,
    getTargetVideo: () => video,
  });
}

function readStackMetric(
  property:
    | "height"
    | "--tentative-slot"
    | "--primary-slot"
    | "--original-slot"
    | "--bar-padding-y",
): number {
  const { captionStack } =
    getOverlayDom();

  if (property === "height") {
    return Number.parseFloat(
      captionStack.style.height,
    );
  }

  return Number.parseFloat(
    captionStack.style.getPropertyValue(
      property,
    ),
  );
}

function primaryOffsetFromStack():
  number {
  const barHeight =
    readStackMetric("height");
  const padY = readStackMetric(
    "--bar-padding-y",
  );
  const content =
    readStackMetric("--primary-slot") +
    readStackMetric("--original-slot") +
    readStackMetric("--tentative-slot");

  return (
    padY +
    (barHeight - padY * 2 - content) / 2
  );
}

function paintLayout(
  overlay: CaptionOverlay,
): void {
  (
    overlay as unknown as {
      updateLayout(): void;
    }
  ).updateLayout();
}

describe(
  "CaptionOverlay caption stack geometry",
  () => {
    it(
      "keeps the tentative slot and bar height while the interim line is enabled",
      () => {
        createLaidOutOverlay({
          showTentative: true,
        });
        const emptySlot = readStackMetric(
          "--tentative-slot",
        );
        const emptyHeight =
          readStackMetric("height");

        expect(emptySlot)
          .toBeGreaterThan(0);
        expect(emptyHeight)
          .toBeGreaterThan(0);

        const overlay = activeOverlay;

        if (overlay === null) {
          throw new Error(
            "Expected an active overlay",
          );
        }

        overlay.showCaption({
          id: 1,
          text: "draft",
          final: false,
          at: "2026-09-01T00:00:00.000Z",
        });

        expect(
          readStackMetric(
            "--tentative-slot",
          ),
        ).toBe(emptySlot);
        expect(
          readStackMetric("height"),
        ).toBe(emptyHeight);
      },
    );

    it(
      "collapses the tentative slot when the interim line is disabled",
      () => {
        const overlay =
          createLaidOutOverlay({
            showTentative: false,
          });

        overlay.showCaption({
          id: 1,
          text: "draft",
          final: false,
          at: "2026-09-01T00:00:00.000Z",
        });

        expect(
          getOverlayDom()
            .tentativeLine.textContent,
        ).toBe("draft");
        expect(
          readStackMetric(
            "--tentative-slot",
          ),
        ).toBe(0);
      },
    );

    it(
      "keeps the primary line's offset when interim text appears and clears",
      () => {
        const overlay =
          createLaidOutOverlay({
            showTentative: true,
          });

        showFinal(overlay, 1, "確定");
        const before =
          primaryOffsetFromStack();

        expect(Number.isFinite(before))
          .toBe(true);

        overlay.showCaption({
          id: 2,
          text: "draft",
          final: false,
          at: "2026-09-01T00:00:01.000Z",
        });
        const during =
          primaryOffsetFromStack();

        getOverlayDom()
          .tentativeLine.textContent = "";
        paintLayout(overlay);
        const after =
          primaryOffsetFromStack();

        expect(during).toBe(before);
        expect(after).toBe(before);
      },
    );
  },
);

describe(
  "CaptionOverlay line budget",
  () => {
    it(
      "records units measurement under jsdom",
      () => {
        createLaidOutOverlay();

        expect(
          getOverlayDom()
            .captionStack
            .dataset
            .captionMeasure,
        ).toBe("units");
        expect(
          getOverlayDom()
            .host
            .dataset
            .captionMeasure,
        ).toBe("units");
      },
    );

    it(
      "records canvas measurement when measureText returns a width",
      () => {
        const proto =
          HTMLCanvasElement.prototype;
        const original = proto.getContext;
        proto.getContext = function getContext() {
          return {
            font: "",
            measureText: () => ({
              width: 10,
            }),
          } as unknown as CanvasRenderingContext2D;
        } as unknown as typeof proto.getContext;

        try {
          createLaidOutOverlay();

          expect(
            getOverlayDom()
              .captionStack
              .dataset
              .captionMeasure,
          ).toBe("canvas");
        } finally {
          proto.getContext = original;
        }
      },
    );

    it(
      "keeps wrapping of an on-screen cue when the snapshot width changes",
      () => {
        let rect = new DOMRect(
          0,
          0,
          320,
          180,
        );
        const video =
          document.createElement(
            "video",
          );
        video.getBoundingClientRect =
          () => rect;
        document.body.append(video);

        const overlay = createOverlay({
          getTargetVideo: () => video,
        });
        const text = "あ".repeat(30);

        showFinal(overlay, 1, text);
        const before = getBlockLines();

        expect(before[0]).not.toBe("");
        expect(before[1]).not.toBe("");
        expect(
          `${before[0]}${before[1]}`,
        ).toBe(text);

        rect = new DOMRect(
          0,
          0,
          1280,
          720,
        );
        paintLayout(overlay);

        expect(getBlockLines()).toEqual(
          before,
        );

        showFinal(overlay, 2, text);
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        expect(getBlockLines()).toEqual([
          text,
          "",
        ]);
      },
    );
  },
);
