export const MAX_MASKED_OCCURRENCES = 4;

export interface MaskPlanEntry {
  number: number;
  term: string;
}

export interface MaskPlan {
  entries: readonly MaskPlanEntry[];
}

export interface MaskedTranslationLine {
  original: string;
  masked: string;
  maskPlan: MaskPlan | null;
}

interface LocatedTerm {
  start: number;
  end: number;
  term: string;
}

export function createMaskPlan(
  original: string,
  properNouns: readonly string[],
  glossaryTerms: readonly string[] = [],
): MaskedTranslationLine {
  const pageOccurrences =
    findNonOverlappingOccurrences(
      original,
      properNouns,
    );

  if (
    pageOccurrences.length >
    MAX_MASKED_OCCURRENCES
  ) {
    return {
      original,
      masked: original,
      maskPlan: null,
    };
  }

  const glossaryOccurrences =
    findNonOverlappingOccurrences(
      original,
      glossaryTerms,
    ).filter(
      (hit) =>
        !pageOccurrences.some(
          (page) =>
            hit.start < page.end &&
            hit.end > page.start,
        ),
    );
  const takenGlossary = [
    ...glossaryOccurrences,
  ]
    .sort(
      (left, right) =>
        right.term.length -
          left.term.length ||
        left.start - right.start,
    )
    .slice(
      0,
      MAX_MASKED_OCCURRENCES -
        pageOccurrences.length,
    );
  const occurrences = [
    ...pageOccurrences,
    ...takenGlossary,
  ].sort(
    (left, right) =>
      left.start - right.start,
  );

  if (occurrences.length === 0) {
    return {
      original,
      masked: original,
      maskPlan: null,
    };
  }

  const entries =
    occurrences.map(
      (occurrence, index) => ({
        number: index + 1,
        term: occurrence.term,
      }),
    );
  const masked = replaceOccurrences(
    original,
    occurrences,
    (_occurrence, index) =>
      `%%${index + 1}%%`,
  );

  return {
    original,
    masked,
    maskPlan: { entries },
  };
}

export function restoreMaskedTranslation(
  output: string,
  maskPlan: MaskPlan | null,
): string | null {
  if (maskPlan === null) {
    return output;
  }

  const entriesByNumber = new Map(
    maskPlan.entries.map(
      (entry) => [
        String(entry.number),
        entry,
      ] as const,
    ),
  );
  const counts = new Map<string, number>(
    maskPlan.entries.map(
      (entry) => [
        String(entry.number),
        0,
      ],
    ),
  );
  let unknownNumber = false;

  const restored = output.replace(
    /%%\s*([0-9]+)\s*%%/gu,
    (
      placeholder: string,
      numberText: string,
    ) => {
      const entry =
        entriesByNumber.get(numberText);

      if (entry === undefined) {
        unknownNumber = true;
        return placeholder;
      }

      counts.set(
        numberText,
        (counts.get(numberText) ?? 0) + 1,
      );
      return entry.term;
    },
  );

  if (
    unknownNumber ||
    restored.includes("%%") ||
    maskPlan.entries.some(
      (entry) =>
        counts.get(String(entry.number)) !==
        1,
    )
  ) {
    return null;
  }

  return restored;
}

export function remaskPlannedTerms(
  text: string,
  maskPlan: MaskPlan,
): string {
  const numbersByTerm =
    new Map<string, number[]>();

  for (const entry of maskPlan.entries) {
    const numbers =
      numbersByTerm.get(entry.term) ?? [];
    numbers.push(entry.number);
    numbersByTerm.set(entry.term, numbers);
  }

  const occurrences =
    findNonOverlappingOccurrences(
      text,
      Array.from(numbersByTerm.keys()),
    );
  const usesByTerm =
    new Map<string, number>();

  return replaceOccurrences(
    text,
    occurrences,
    (occurrence) => {
      const numbers =
        numbersByTerm.get(occurrence.term);

      if (
        numbers === undefined ||
        numbers.length === 0
      ) {
        return occurrence.term;
      }

      const used =
        usesByTerm.get(occurrence.term) ?? 0;
      usesByTerm.set(
        occurrence.term,
        used + 1,
      );

      return (
        `%%${numbers[used % numbers.length]}%%`
      );
    },
  );
}

function normalizeTerms(
  terms: readonly string[],
): string[] {
  return Array.from(
    new Set(
      terms
        .map((term) => term.trim())
        .filter((term) => term !== ""),
    ),
  ).sort(
    (left, right) =>
      right.length - left.length,
  );
}

function findNonOverlappingOccurrences(
  text: string,
  terms: readonly string[],
): LocatedTerm[] {
  const occurrences: LocatedTerm[] = [];

  for (const term of normalizeTerms(terms)) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9'])`,
      "gu",
    );

    for (const match of text.matchAll(pattern)) {
      const start = match.index;

      if (start === undefined) {
        continue;
      }

      const end = start + match[0].length;

      if (
        occurrences.some(
          (occurrence) =>
            start < occurrence.end &&
            end > occurrence.start,
        )
      ) {
        continue;
      }

      occurrences.push({
        start,
        end,
        term,
      });
    }
  }

  return occurrences.sort(
    (left, right) =>
      left.start - right.start,
  );
}

function replaceOccurrences(
  text: string,
  occurrences: readonly LocatedTerm[],
  replacement: (
    occurrence: LocatedTerm,
    index: number,
  ) => string,
): string {
  const parts: string[] = [];
  let cursor = 0;

  occurrences.forEach(
    (occurrence, index) => {
      parts.push(
        text.slice(cursor, occurrence.start),
        replacement(occurrence, index),
      );
      cursor = occurrence.end;
    },
  );

  parts.push(text.slice(cursor));
  return parts.join("");
}

function escapeRegExp(value: string): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
}
