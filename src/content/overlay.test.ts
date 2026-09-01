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

function createOverlay(
  options: {
    showOriginal?: boolean;
    onCaptionFadeOut?: () => void;
  } = {},
): CaptionOverlay {
  const overlay = new CaptionOverlay({
    getTargetVideo: () => null,
    showOriginal:
      options.showOriginal ?? false,
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
        ).toBe(
          "最初の字幕次の字幕",
        );
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
        ).toBe(
          "最初の字幕次の字幕",
        );
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
  "CaptionOverlay append display buffer",
  () => {
    it(
      "keeps the previous bottom line when new clauses arrive",
      () => {
        const overlay = createOverlay();

        showFinal(overlay, 1, "A");
        expect(getBlockLines()).toEqual(
          ["", "A"],
        );

        showFinal(overlay, 2, "B");
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        expect(getBlockLines()).toEqual(
          ["A", "B"],
        );

        showFinal(overlay, 3, "C");
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        expect(getBlockLines()).toEqual(
          ["B", "C"],
        );
      },
    );

    it(
      "scrolls every line of a long clause within the existing cue dwell budget",
      () => {
        const overlay = createOverlay();
        const snapshots:
          Array<[string, string]> = [];

        showFinal(
          overlay,
          1,
          "あ".repeat(50),
        );
        snapshots.push(getBlockLines());

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS / 2,
        );
        snapshots.push(getBlockLines());

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS / 2,
        );
        snapshots.push(getBlockLines());

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS / 2,
        );
        snapshots.push(getBlockLines());

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS / 2 - 1,
        );
        showFinal(overlay, 2, "次");
        vi.advanceTimersByTime(1);
        snapshots.push(getBlockLines());

        for (
          let index = 1;
          index < snapshots.length;
          index += 1
        ) {
          expect(
            snapshots[index]?.[0],
          ).toBe(
            snapshots[index - 1]?.[1],
          );
        }

        expect(
          snapshots.every(
            ([top, bottom]) =>
              top !== "" || bottom !== "",
          ),
        ).toBe(true);
        expect(
          getOverlayDom()
            .cueContainer
            .querySelector<HTMLElement>(
              ".caption-cue",
            )
            ?.dataset.cueId,
        ).toBe("2:0");
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
          ["", "A"],
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
      "surfaces every line of a cue that wraps past two lines",
      () => {
        const overlay = createOverlay({});
        // wrapCueText breaks this 28-unit part into three lines because the
        // boundary rules refuse the positions near the budget. The old display
        // had two line slots with overflow hidden, so the third one vanished.
        const threeLineText =
          "おネち5ナbた1）6c オネz0と3そ4たく0 2ア pてせ、ぬ c ）、";
        const expected = wrapCueText(
          threeLineText,
          MAX_LINE_UNITS,
        ).split("\n");

        expect(
          expected.length,
        ).toBeGreaterThan(2);

        showFinal(
          overlay,
          1,
          threeLineText,
        );

        // A cue splits its dwell across its lines, so sampling once per dwell
        // steps over the middle one. Sample both slots at a fraction of it.
        const seen = new Set<string>();
        const step = Math.ceil(
          CUE_MINIMUM_DISPLAY_MS / 10,
        );

        for (
          let elapsed = 0;
          elapsed <=
            CUE_MINIMUM_DISPLAY_MS * 2;
          elapsed += step
        ) {
          for (const slot of getBlockLines()) {
            if (slot !== "") seen.add(slot);
          }

          vi.advanceTimersByTime(step);
        }

        for (const line of expected) {
          expect([...seen]).toContain(line);
        }
      },
    );

    it(
      "appends only the new tail when a clause is revised longer",
      () => {
        const overlay = createOverlay({});

        showFinal(overlay, 1, "これは途中まで");
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );
        showFinal(
          overlay,
          2,
          "これは途中まで届いた文です。",
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
      "shows a line pending at stop before drain completion",
      () => {
        const onCaptionFadeOut = vi.fn();
        const overlay = createOverlay({
          onCaptionFadeOut,
        });

        showFinal(
          overlay,
          1,
          "あ".repeat(20),
        );
        const first = getBlockLines();

        expect(first[0]).toBe("");
        expect(first[1]).not.toBe("");
        expect(
          overlay.hasPendingCaption(),
        ).toBe(true);

        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS / 2,
        );

        expect(getBlockLines()[0]).toBe(
          first[1],
        );
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
          "あ".repeat(20),
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
          ["", "確定"],
        );
        expect(
          getOverlayDom()
            .tentativeLine.textContent,
        ).toBe("");
      },
    );

    it(
      "updates one original line and starts empty after reconstruction",
      () => {
        const overlay = createOverlay({
          showOriginal: true,
        });

        showFinal(
          overlay,
          1,
          "A",
          "Original one",
        );
        showFinal(
          overlay,
          2,
          "B",
          "Original two",
        );
        vi.advanceTimersByTime(
          CUE_MINIMUM_DISPLAY_MS,
        );

        const { cueContainer } =
          getOverlayDom();
        expect(
          cueContainer.querySelectorAll(
            ".caption-original",
          ),
        ).toHaveLength(1);
        expect(
          requireElement<HTMLDivElement>(
            cueContainer,
            ".caption-original",
          ).textContent,
        ).toBe("Original two");

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
      "keeps queue drops while scrolling the retained cues",
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
      "freezes a pending line while playback is paused",
      () => {
        const overlay = createOverlay();

        showFinal(
          overlay,
          1,
          "あ".repeat(20),
        );
        const first = getBlockLines();

        vi.advanceTimersByTime(500);
        overlay.setPlaybackPaused(true);
        vi.advanceTimersByTime(1_000);

        expect(getBlockLines()).toEqual(
          first,
        );

        overlay.setPlaybackPaused(false);
        vi.advanceTimersByTime(249);
        expect(getBlockLines()).toEqual(
          first,
        );

        vi.advanceTimersByTime(1);
        expect(getBlockLines()[0]).toBe(
          first[1],
        );
      },
    );

    it(
      "allows intended appends but reports a direct text rewrite",
      async () => {
        const overlay = createOverlay({
          showOriginal: true,
        });

        showFinal(
          overlay,
          1,
          "あ".repeat(20),
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
          CUE_MINIMUM_DISPLAY_MS / 2,
        );
        await flushCueMutations();

        expect(
          host.dataset.cueMutations,
        ).toBe("0");

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
