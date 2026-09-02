// @vitest-environment jsdom

import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MAX_CONTEXT_TERMS,
} from "../shared/messages";
import {
  createCaptureState,
} from "../shared/state";
import {
  CUE_MINIMUM_DISPLAY_MS,
} from "./overlay";

let extractPostContextTerms:
  typeof import("./index").extractPostContextTerms;
let handleOffscreenDevLog:
  typeof import("./index").handleOffscreenDevLog;
let handleCaptureState:
  typeof import("./index").handleCaptureState;
let ensureOverlay:
  typeof import("./index").ensureOverlay;

class ResizeObserverStub {
  observe(): void {
  }

  disconnect(): void {
  }
}

function setPostText(text: string): void {
  document.body.innerHTML =
    "<main><article></article></main>";

  const article =
    document.querySelector("main article");

  if (!(article instanceof HTMLElement)) {
    throw new Error("Test article was not created");
  }

  article.textContent = text;
}

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({
        version: "test",
      }),
    },
  });

  (
    window as Window & {
      __xJimakuContentScriptVersion__?:
        string;
    }
  ).__xJimakuContentScriptVersion__ =
    "test";

  ({
    extractPostContextTerms,
    handleOffscreenDevLog,
    handleCaptureState,
    ensureOverlay,
  } = await import("./index"));
});

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    "/tester/status/49",
  );
});

describe("handleOffscreenDevLog", () => {
  it(
    "posts a structured entry on the development origin",
    () => {
      const originalLocation = location;
      const data = {
        kind: "passthrough" as const,
        requestId: "request-63",
        lineId: 1,
      };
      const postMessage = vi
        .spyOn(window, "postMessage")
        .mockImplementation(() => {
        });
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => {
        });

      try {
        vi.stubGlobal("location", {
          origin: "http://127.0.0.1:8123",
        });

        handleOffscreenDevLog({
          t: "OFF_DEV_LOG",
          level: "info",
          tag: "translate",
          message:
            "Translator line rescue exhausted; passing through original",
          data,
        });

        expect(postMessage).toHaveBeenCalledWith(
          {
            t: "OFF_DEV_LOG",
            level: "info",
            tag: "translate",
            message:
              "Translator line rescue exhausted; passing through original",
            data,
            timestampMs: expect.any(Number),
          },
          "http://127.0.0.1:8123",
        );
      } finally {
        vi.stubGlobal(
          "location",
          originalLocation,
        );
        postMessage.mockRestore();
        info.mockRestore();
      }
    },
  );

  it(
    "does not post or print on a non-development origin",
    () => {
      expect(location.origin).not.toBe(
        "http://127.0.0.1:8123",
      );

      const postMessage = vi
        .spyOn(window, "postMessage")
        .mockImplementation(() => {
        });
      const methods = [
        vi
          .spyOn(console, "info")
          .mockImplementation(() => {
          }),
        vi
          .spyOn(console, "warn")
          .mockImplementation(() => {
          }),
        vi
          .spyOn(console, "error")
          .mockImplementation(() => {
          }),
      ];

      handleOffscreenDevLog({
        t: "OFF_DEV_LOG",
        level: "info",
        tag: "translate",
        message:
          "Translator line rescue exhausted; passing through original",
        data: {
          kind: "passthrough",
          requestId: "request-63",
          lineId: 1,
        },
      });

      expect(postMessage).not.toHaveBeenCalled();
      postMessage.mockRestore();

      for (const method of methods) {
        expect(method).not.toHaveBeenCalled();
        method.mockRestore();
      }
    },
  );
});

describe("explicit-stop overlay lifecycle", () => {
  it("A-6-4(c') destroys timed-out drain state before the next capture", () => {
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
      vi.fn(),
    );

    try {
      handleCaptureState(
        createCaptureState("starting", {
          requestId: "request-old",
        }),
      );
      const first = ensureOverlay();
      first.beginDrain();

      handleCaptureState(
        createCaptureState("idle", {
          requestId: "request-old",
        }),
      );

      expect(
        document.querySelector(
          "#xjsub-host",
        ),
      ).toBeNull();

      handleCaptureState(
        createCaptureState("starting", {
          requestId: "request-new",
        }),
      );
      const second = ensureOverlay();

      expect(second).not.toBe(first);

      second.showCaption({
        id: 1,
        text: "source",
        ja:
          "おネち5ナbた1）6c オネz0と3そ4たく0 2ア pてせ、ぬ c ）、",
        final: true,
        at: "2026-09-02T00:00:00.000Z",
      });
      second.setPlaybackPaused(true);
      vi.advanceTimersByTime(
        CUE_MINIMUM_DISPLAY_MS,
      );

      const host =
        document.querySelector(
          "#xjsub-host",
        );
      const cue =
        host?.shadowRoot?.querySelector<
          HTMLElement
        >(".caption-cue");

      expect(cue?.dataset.pageId).toBe(
        "0",
      );
    } finally {
      handleCaptureState(
        createCaptureState("idle", {
          requestId: "request-new",
        }),
      );
      vi.useRealTimers();
    }
  });
});

describe("extractPostContextTerms", () => {
  it(
    "splits after an acronym that ends a sentence",
    () => {
      setPostText(
        "NASA. Kennedy Space Center opened.",
      );

      const acronymTerms =
        extractPostContextTerms();

      expect(acronymTerms).toContain(
        "Kennedy Space Center",
      );
      expect(acronymTerms).not.toContain(
        "NASA Kennedy Space Center",
      );
    },
  );

  it(
    "keeps a title abbreviation inside a run",
    () => {
      setPostText(
        "Fly to St. Louis Airport today.",
      );

      expect(
        extractPostContextTerms(),
      ).toContain("St. Louis Airport");
    },
  );

  it(
    "keeps a standalone dotted abbreviation",
    () => {
      setPostText(
        "U.S. officials spoke today.",
      );

      expect(
        extractPostContextTerms(),
      ).toContain("U.S.");
    },
  );

  it(
    "keeps abbreviation periods inside a run",
    () => {
      setPostText(
        "The U.S. Space Force launched.",
      );

      expect(
        extractPostContextTerms(),
      ).toContain("U.S. Space Force");
    },
  );


  it(
    "appends multi-word terms after their single-token components",
    () => {
      setPostText(
        "NASA Goddard. Kennedy Space Center.",
      );

      expect(
        extractPostContextTerms(),
      ).toEqual([
        "NASA",
        "Goddard",
        "Kennedy",
        "Space",
        "Center",
        "NASA Goddard",
        "Kennedy Space Center",
      ]);
    },
  );

  it(
    "normalizes whitespace and accepts two-character capitalized tokens",
    () => {
      setPostText("Ab \n\t Cd.");

      expect(
        extractPostContextTerms(),
      ).toEqual(["Ab Cd"]);
    },
  );

  it(
    "keeps only the first four words of a maximal run",
    () => {
      setPostText(
        "Alpha Bravo Charlie Delta Echo.",
      );

      expect(
        extractPostContextTerms(),
      ).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
        "Echo",
        "Alpha Bravo Charlie Delta",
      ]);
    },
  );

  it(
    "applies the stoplist to the joined key without breaking the run",
    () => {
      setPostText("After Before.");

      expect(
        extractPostContextTerms(),
      ).toEqual(["After Before"]);
    },
  );

  it(
    "does not include a handle in a multi-word run",
    () => {
      setPostText("@NASA Goddard.");

      expect(
        extractPostContextTerms(),
      ).toEqual([
        "@NASA",
        "Goddard",
      ]);
    },
  );

  it(
    "preserves single-token priority at the shared term limit",
    () => {
      const filler = Array.from(
        {
          length:
            MAX_CONTEXT_TERMS - 2,
        },
        (_, index) => `Name${index}`,
      );

      setPostText(
        `${filler.join(". ")}. NASA Goddard.`,
      );

      const terms =
        extractPostContextTerms();

      expect(terms).toHaveLength(
        MAX_CONTEXT_TERMS,
      );
      expect(terms.slice(-2)).toEqual([
        "NASA",
        "Goddard",
      ]);
      expect(terms).not.toContain(
        "NASA Goddard",
      );
    },
  );

  it(
    "rejects a joined term longer than 128 characters",
    () => {
      const first =
        `A${"a".repeat(64)}`;
      const second =
        `B${"b".repeat(64)}`;

      setPostText(`${first} ${second}.`);

      expect(
        extractPostContextTerms(),
      ).toEqual([
        first,
        second,
      ]);
    },
  );
});
