import {
  GLOSSARY_TERMS,
  NAME_TERMS,
} from "./glossary.data";
import type {
  GlossaryTerm,
  NameTerm,
} from "./glossary.data";

export const KEEP_LATIN_MATCH_CAP = 6;
export const GLOSSARY_MATCH_CAP = 4;
const NAME_BY_TERM = new Map(
  NAME_TERMS.map((entry) => [
    entry.term.toLowerCase(),
    entry,
  ]),
);

function japaneseRendering(
  entry: NameTerm,
): string {
  if (
    entry.ja === undefined ||
    entry.ja.trim() === ""
  ) {
    throw new Error(
      `NAME_TERMS row ${entry.term} is missing ja`,
    );
  }

  return entry.ja;
}

export function renderNameTerm(
  term: string,
): string {
  const entry = NAME_BY_TERM.get(
    term.toLowerCase(),
  );

  if (entry === undefined) {
    return term;
  }

  return entry.render === "ja"
    ? japaneseRendering(entry)
    : entry.term;
}

export interface GlossarySelection {
  readonly keepLatin: readonly NameTerm[];
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
        NAME_TERMS,
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
