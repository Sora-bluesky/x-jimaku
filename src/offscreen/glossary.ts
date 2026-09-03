import {
  GLOSSARY_TERMS,
  KEEP_LATIN_TERMS,
} from "./glossary.data";
import type {
  GlossaryTerm,
  KeepLatinTerm,
} from "./glossary.data";

export const KEEP_LATIN_MATCH_CAP = 6;
export const GLOSSARY_MATCH_CAP = 4;
export const KEEP_LATIN_MASK_TERMS =
  KEEP_LATIN_TERMS.filter(
    (entry) =>
      entry.ambiguous !== true,
  ).map((entry) => entry.term);
export const KEEP_LATIN_ALL_TERMS =
  KEEP_LATIN_TERMS.map(
    (entry) => entry.term,
  );

const AMBIGUOUS_KEEP_LATIN = new Set(
  KEEP_LATIN_TERMS.filter(
    (entry) =>
      entry.ambiguous === true,
  ).map((entry) => entry.term),
);

export interface GlossarySelection {
  readonly keepLatin: readonly KeepLatinTerm[];
  readonly glossary: readonly GlossaryTerm[];
}

interface LocatedTerm<T> {
  readonly entry: T;
  readonly start: number;
  readonly end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
}

// Not \\b: hyphens inside GPT-4 stay in the
// term, and xAI / clause edges still match.
// Trailing ' is out so Roman's ≠ Roman.
function termPattern(
  term: string,
  ignoreCase: boolean,
): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9'])`,
    ignoreCase ? "giu" : "gu",
  );
}

export function allowKeepLatinMaskOccurrence(
  clause: string,
  occurrence: {
    readonly term: string;
    readonly start: number;
    readonly end: number;
  },
  properNouns: readonly string[] = [],
): boolean {
  if (
    !AMBIGUOUS_KEEP_LATIN.has(
      occurrence.term,
    )
  ) {
    return true;
  }

  return (
    pageNamesTerm(
      occurrence.term,
      properNouns,
    ) ||
    hasVersionAfter(
      clause,
      occurrence.end,
    ) ||
    hasFamilyNeighbour(
      clause,
      occurrence.start,
      occurrence.end,
    )
  );
}

function pageNamesTerm(
  term: string,
  properNouns: readonly string[],
): boolean {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9'])`,
    "iu",
  );

  return properNouns.some(
    (noun) => pattern.test(noun),
  );
}

function hasVersionAfter(
  clause: string,
  end: number,
): boolean {
  // Dotted (4.5) or one digit (4).
  // Two-digit Opus 27 stays ordinary.
  return /^\s*(?:\d+\.\d+|[1-9])(?![0-9])/u
    .test(clause.slice(end));
}

function hasFamilyNeighbour(
  clause: string,
  start: number,
  end: number,
): boolean {
  const source = KEEP_LATIN_MASK_TERMS
    .slice()
    .sort(
      (left, right) =>
        right.length - left.length,
    )
    .map(escapeRegExp)
    .join("|");

  if (source === "") {
    return false;
  }

  // Term match rejects Anthropic's;
  // this still treats it as a neighbour.
  const before = new RegExp(
    `(?<![A-Za-z0-9])(?:${source})(?:['’]s)?(?:\\s+\\d+(?:\\.\\d+)*)?\\s+$`,
    "iu",
  );
  const after = new RegExp(
    `^\\s+(?:${source})(?![A-Za-z0-9'])`,
    "iu",
  );

  return (
    before.test(
      clause.slice(0, start),
    ) ||
    after.test(clause.slice(end))
  );
}

function locateTerms<
  T extends { readonly term: string },
>(
  clause: string,
  entries: readonly T[],
  ignoreCase: boolean,
): LocatedTerm<T>[] {
  const ranked = [...entries].sort(
    (left, right) =>
      right.term.length - left.term.length,
  );
  const located: LocatedTerm<T>[] = [];

  for (const entry of ranked) {
    const pattern = termPattern(
      entry.term,
      ignoreCase,
    );

    for (const match of clause.matchAll(
      pattern,
    )) {
      const start = match.index;

      if (start === undefined) {
        continue;
      }

      const end = start + match[0].length;

      if (
        located.some(
          (hit) =>
            start < hit.end &&
            end > hit.start,
        )
      ) {
        continue;
      }

      located.push({
        entry,
        start,
        end,
      });
    }
  }

  return located;
}

function capLocated<
  T extends { readonly term: string },
>(
  located: readonly LocatedTerm<T>[],
  cap: number,
): T[] {
  const chosen: LocatedTerm<T>[] = [];
  const seen = new Set<string>();
  const ranked = [...located].sort(
    (left, right) =>
      right.entry.term.length -
        left.entry.term.length ||
      left.start - right.start,
  );

  for (const hit of ranked) {
    if (seen.has(hit.entry.term)) {
      continue;
    }

    seen.add(hit.entry.term);
    chosen.push(hit);

    if (chosen.length === cap) {
      break;
    }
  }

  return chosen
    .sort(
      (left, right) =>
        left.start - right.start,
    )
    .map((hit) => hit.entry);
}

export function selectGlossaryMatches(
  clause: string,
): GlossarySelection {
  return {
    keepLatin: capLocated(
      locateTerms(
        clause,
        KEEP_LATIN_TERMS,
        true,
      ),
      KEEP_LATIN_MATCH_CAP,
    ),
    glossary: capLocated(
      locateTerms(
        clause,
        GLOSSARY_TERMS,
        true,
      ),
      GLOSSARY_MATCH_CAP,
    ),
  };
}

function formatKeepLatinBlock(
  entries: readonly KeepLatinTerm[],
): string | null {
  if (entries.length === 0) {
    return null;
  }

  const definite: string[] = [];
  const ambiguous: string[] = [];

  for (const entry of entries) {
    if (entry.ambiguous === true) {
      ambiguous.push(entry.term);
    } else {
      definite.push(entry.term);
    }
  }

  const lines = ["[原綴り]"];

  if (definite.length > 0) {
    lines.push(definite.join(", "));
  }

  if (ambiguous.length > 0) {
    lines.push(
      `モデル・製品・組織名のときだけ原綴り（一般語は訳す）: ${ambiguous.join(", ")}`,
    );
  }

  return lines.join("\n");
}

function formatGlossaryBlock(
  entries: readonly GlossaryTerm[],
): string | null {
  if (entries.length === 0) {
    return null;
  }

  return [
    "[用語]",
    ...entries.map(
      (entry) =>
        `${entry.term} = ${entry.ja}`,
    ),
  ].join("\n");
}

export function glossaryPromptBlocks(
  selection: GlossarySelection,
): string[] {
  const blocks: string[] = [];
  const keepLatin = formatKeepLatinBlock(
    selection.keepLatin,
  );
  const glossary = formatGlossaryBlock(
    selection.glossary,
  );

  if (keepLatin !== null) {
    blocks.push(keepLatin);
  }

  if (glossary !== null) {
    blocks.push(glossary);
  }

  return blocks;
}

export interface KatakanaNameRendering {
  readonly term: string;
  readonly rendering: string;
}

export function countKatakanaNameHits(
  text: string,
  entries: readonly KeepLatinTerm[],
  renderings: readonly KatakanaNameRendering[],
): {
  readonly ambiguous: number;
  readonly plain: number;
} {
  const ambiguousTerms = new Set(
    entries
      .filter(
        (entry) =>
          entry.ambiguous === true,
      )
      .map((entry) => entry.term),
  );
  let ambiguous = 0;
  let plain = 0;

  for (const rendering of renderings) {
    const hits =
      text.split(rendering.rendering)
        .length - 1;

    if (
      ambiguousTerms.has(
        rendering.term,
      )
    ) {
      ambiguous += hits;
    } else {
      plain += hits;
    }
  }

  return { ambiguous, plain };
}
