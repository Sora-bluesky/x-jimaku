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

let extractPostContextTerms:
  typeof import("./index").extractPostContextTerms;

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
  } = await import("./index"));
});

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    "/tester/status/49",
  );
});

describe("extractPostContextTerms", () => {
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
