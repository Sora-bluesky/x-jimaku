import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MAX_SENTENCE_WORDS,
  SENTENCE_ASSEMBLY_TIMEOUT_MS,
  SentenceAssembler,
} from "./sentence-assembler";
import type {
  RecognitionLine,
} from "./segmenter";

interface EmittedLine {
  requestId: string;
  line: RecognitionLine;
}

function createLine(
  id: number,
  text: string,
  final = true,
): RecognitionLine {
  return {
    id,
    text,
    final,
    at:
      "2026-08-30T00:00:" +
      `${String(id).padStart(2, "0")}.000Z`,
  };
}

function createHarness(): {
  assembler: SentenceAssembler;
  emitted: EmittedLine[];
} {
  const emitted: EmittedLine[] = [];
  const assembler =
    new SentenceAssembler({
      onLine(requestId, line) {
        emitted.push({
          requestId,
          line,
        });
      },
    });

  return {
    assembler,
    emitted,
  };
}

describe("SentenceAssembler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([".", "?", "!"])(
    "emits immediately when the bundle ends in %s",
    (punctuation) => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:1",
        createLine(1, "We are"),
      );
      assembler.accept(
        "capture:1",
        createLine(
          2,
          `ready${punctuation}`,
        ),
      );

      expect(emitted).toEqual([
        {
          requestId: "capture:1",
          line: {
            ...createLine(
              2,
              `ready${punctuation}`,
            ),
            text:
              `We are ready${punctuation}`,
          },
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "does not treat the final dot in U.S. as a sentence end",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:1",
        createLine(
          1,
          "The U.S.",
        ),
      );

      expect(emitted).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);

      assembler.flush("capture:1");

      expect(
        emitted[0]?.line.text,
      ).toBe("The U.S.");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "treats a multi-capital acronym dot as a sentence end",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:1",
        createLine(
          1,
          "They work at NASA.",
        ),
      );

      expect(
        emitted[0]?.line.text,
      ).toBe("They work at NASA.");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "emits when the sentence end is followed by closing quotes",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:1",
        createLine(
          1,
          'He said "no."',
        ),
      );

      expect(
        emitted[0]?.line.text,
      ).toBe('He said "no."');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "emits at the twenty-word cap with the last clause id",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();
      const firstTen =
        "one two three four five six seven eight nine ten";
      const secondTen =
        "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";

      assembler.accept(
        "capture:1",
        createLine(4, firstTen),
      );
      assembler.accept(
        "capture:1",
        createLine(5, secondTen),
      );

      expect(
        `${firstTen} ${secondTen}`
          .split(/\s+/u),
      ).toHaveLength(
        MAX_SENTENCE_WORDS,
      );
      expect(emitted).toEqual([
        {
          requestId: "capture:1",
          line: {
            ...createLine(
              5,
              secondTen,
            ),
            text:
              `${firstTen} ${secondTen}`,
          },
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "starts the four-second timer at the first bundled clause",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:1",
        createLine(1, "This timer"),
      );

      vi.advanceTimersByTime(3_000);

      assembler.accept(
        "capture:1",
        createLine(
          2,
          "still uses the first clause",
        ),
      );

      vi.advanceTimersByTime(
        SENTENCE_ASSEMBLY_TIMEOUT_MS -
          3_001,
      );
      expect(emitted).toEqual([]);

      vi.advanceTimersByTime(1);

      expect(emitted).toEqual([
        {
          requestId: "capture:1",
          line: {
            ...createLine(
              2,
              "still uses the first clause",
            ),
            text:
              "This timer still uses the first clause",
          },
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "emits an unfinished bundle when flush completes",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:1",
        createLine(7, "An unfinished"),
      );
      assembler.accept(
        "capture:1",
        createLine(8, "sentence fragment"),
      );

      assembler.flush("capture:1");

      expect(emitted).toEqual([
        {
          requestId: "capture:1",
          line: {
            ...createLine(
              8,
              "sentence fragment",
            ),
            text:
              "An unfinished sentence fragment",
          },
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it(
    "discards on a new capture and destroy, cancelling both timers",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.accept(
        "capture:old",
        createLine(1, "old fragment"),
      );
      expect(vi.getTimerCount()).toBe(1);

      assembler.startCapture(
        "capture:new",
      );
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(
        SENTENCE_ASSEMBLY_TIMEOUT_MS,
      );
      expect(emitted).toEqual([]);

      assembler.accept(
        "capture:new",
        createLine(2, "new fragment"),
      );
      assembler.flush("capture:new");

      expect(
        emitted.map(
          ({ line }) => line.text,
        ),
      ).toEqual(["new fragment"]);

      assembler.accept(
        "capture:destroy",
        createLine(3, "discard me"),
      );
      expect(vi.getTimerCount()).toBe(1);

      assembler.destroy();
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(
        SENTENCE_ASSEMBLY_TIMEOUT_MS,
      );
      assembler.accept(
        "capture:destroy",
        createLine(4, "ignored"),
      );

      expect(
        emitted.map(
          ({ line }) => line.text,
        ),
      ).toEqual(["new fragment"]);
    },
  );

  it(
    "passes interim lines through without touching the final bundle",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();
      const interim = createLine(
        2,
        "tentative text",
        false,
      );

      assembler.accept(
        "capture:1",
        createLine(1, "Bundled clause"),
      );
      assembler.accept(
        "capture:1",
        interim,
      );

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.line).toBe(
        interim,
      );
      expect(vi.getTimerCount()).toBe(1);

      assembler.flush("capture:1");

      expect(emitted).toHaveLength(2);
      expect(emitted[1]?.line).toEqual(
        createLine(
          1,
          "Bundled clause",
        ),
      );
    },
  );

  it.each([
    "service-worker restart",
    "grace reconnect",
    "tab switch",
  ])(
    "keeps the same-request bundle during %s",
    () => {
      const {
        assembler,
        emitted,
      } = createHarness();

      assembler.startCapture(
        "capture:1",
      );
      assembler.accept(
        "capture:1",
        createLine(1, "held fragment"),
      );

      assembler.startCapture(
        "capture:1",
      );

      expect(vi.getTimerCount()).toBe(1);

      assembler.flush("capture:1");

      expect(
        emitted[0]?.line.text,
      ).toBe("held fragment");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
