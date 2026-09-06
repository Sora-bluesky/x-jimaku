import type { NameTerm } from "./glossary.data";

export const MAX_MASKED_OCCURRENCES = 4;
export const MIN_REMAINING_CONTENT_WORDS = 3;

const FUNCTION_WORDS = new Set(
  ("the a an is are was were be been to of in on at for by with and or but " +
    "it its this that these those will would can could has have had not as from").split(" "),
);

export function countContentWords(text: string): number {
  return (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [])
    .filter((word) => !FUNCTION_WORDS.has(word.toLowerCase()))
    .length;
}

export interface MaskPlanEntry {
  number: number;
  term: string;
  render: string;
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
  allowGlossaryOccurrence?: (
    occurrence: LocatedTerm,
  ) => boolean,
  renderGlossaryTerm: (
    term: string,
  ) => string = (term) => term,
): MaskedTranslationLine {
  const glossaryOccurrences =
    findAllOccurrences(
      original,
      glossaryTerms,
    ).filter(
      (hit) =>
        allowGlossaryOccurrence ===
          undefined ||
        allowGlossaryOccurrence(hit),
    ).map((hit) => ({
      ...hit,
      render: renderGlossaryTerm(hit.term),
    }));
  const pageOccurrences =
    findNonOverlappingOccurrences(
      original,
      properNouns,
    ).filter(
      (hit) =>
        !glossaryOccurrences.some(
          (table) =>
            hit.start < table.end &&
            hit.end > table.start,
        ),
    ).map((hit) => ({
      ...hit,
      render: hit.term,
    }));

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
  const glossaryCandidates = [
    ...glossaryOccurrences,
  ]
    .sort(
      (left, right) =>
        right.term.length -
          left.term.length ||
        left.start - right.start,
    );
  const takenGlossary: typeof glossaryCandidates = [];
  const glossaryLimit =
    MAX_MASKED_OCCURRENCES - pageOccurrences.length;

  for (const candidate of glossaryCandidates) {
    if (takenGlossary.length >= glossaryLimit) {
      break;
    }
    if (
      takenGlossary.some(
        (taken) =>
          candidate.start < taken.end &&
          candidate.end > taken.start,
      )
    ) {
      continue;
    }

    const candidateText = replaceOccurrences(
      original,
      [...pageOccurrences, ...takenGlossary, candidate]
        .sort((left, right) => left.start - right.start),
      () => "%%0%%",
    );

    if (
      countContentWords(candidateText) <
      MIN_REMAINING_CONTENT_WORDS
    ) {
      continue;
    }
    takenGlossary.push(candidate);
  }

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
        render: occurrence.render,
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

  let restored = "";
  let cursor = 0;
  let previousRenderEndsInJapanese = false;

  for (const match of output.matchAll(
    placeholderRegex(),
  )) {
    const start = match.index;

    if (start === undefined) {
      continue;
    }

    let literal = output.slice(cursor, start);

    if (previousRenderEndsInJapanese) {
      literal = literal.replace(
        /^ +(?=\p{Script=Hiragana})/u,
        "",
      );
    }

    restored += literal;

    const numberKey =
      asciiPlaceholderNumber(
        match[1] ?? "",
      );
    const entry =
      entriesByNumber.get(numberKey);

    if (entry === undefined) {
      unknownNumber = true;
      restored += match[0];
      previousRenderEndsInJapanese = false;
    } else {
      counts.set(
        numberKey,
        (counts.get(numberKey) ?? 0) + 1,
      );

      if (
        /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々]/u
          .test(entry.render)
      ) {
        // Only a particle or verb ending (hiragana) closes the gap; a space
        // between two names or before a kanji word stays.
        restored = restored.replace(
          /(?<=\p{Script=Hiragana}) +$/u,
          "",
        );
      }

      restored += entry.render;
      previousRenderEndsInJapanese =
        /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々]$/u
          .test(entry.render);
    }

    cursor = start + match[0].length;
  }

  let tail = output.slice(cursor);

  if (previousRenderEndsInJapanese) {
    tail = tail.replace(
      /^ +(?=\p{Script=Hiragana})/u,
      "",
    );
  }

  restored += tail;

  if (
    unknownNumber ||
    restored.includes("%%") ||
    restored.includes("％％") ||
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

export function explainRestoreRefusal(
  output: string,
  maskPlan: MaskPlan | null,
): "none" | "unknown-number" | "missing" | "duplicate" | "stray-marker" {
  if (maskPlan === null) {
    return "none";
  }

  const plannedNumbers = maskPlan.entries.map(
    (entry) => String(entry.number),
  );
  const returnedNumbers = Array.from(
    output.matchAll(placeholderRegex()),
    (match) =>
      asciiPlaceholderNumber(
        match[1] ?? "",
      ),
  );

  if (returnedNumbers.some(
    (number) => !plannedNumbers.includes(number),
  )) {
    return "unknown-number";
  }

  if (plannedNumbers.some(
    (number) => !returnedNumbers.includes(number),
  )) {
    return "missing";
  }

  if (returnedNumbers.some(
    (number, index) =>
      returnedNumbers.indexOf(number) !== index,
  )) {
    return "duplicate";
  }

  const remaining =
    output.replace(placeholderRegex(), "");

  if (
    remaining.includes("%%") ||
    remaining.includes("％％")
  ) {
    return "stray-marker";
  }

  return "none";
}

export function countIntactPlaceholders(
  output: string,
  maskPlan: MaskPlan | null,
): {
  sent: number;
  returned: number;
} {
  if (maskPlan === null) {
    return {
      sent: 0,
      returned: 0,
    };
  }

  const planned = new Set(
    maskPlan.entries.map((entry) =>
      String(entry.number),
    ),
  );
  const seen = new Set<string>();

  for (const match of output.matchAll(
    placeholderRegex(),
  )) {
    const numberKey =
      asciiPlaceholderNumber(
        match[1] ?? "",
      );

    if (planned.has(numberKey)) {
      seen.add(numberKey);
    }
  }

  return {
    sent: maskPlan.entries.length,
    returned: seen.size,
  };
}

function placeholderRegex(): RegExp {
  return /[%％]{2}\s*([0-9０-９]+)\s*[%％]{2}/gu;
}

function asciiPlaceholderNumber(
  numberText: string,
): string {
  return numberText.replace(
    /[０-９]/gu,
    (digit) =>
      String(
        digit.charCodeAt(0) - 0xff10,
      ),
  );
}

export function remaskPlannedTerms(
  text: string,
  maskPlan: MaskPlan,
): string {
  const numbersByTerm =
    new Map<string, number[]>();

  for (const entry of maskPlan.entries) {
    const searchable =
      entry.render === entry.term
        ? [entry.term]
        : [entry.term, entry.render];

    for (const term of searchable) {
      const numbers =
        numbersByTerm.get(term) ?? [];
      numbers.push(entry.number);
      numbersByTerm.set(term, numbers);
    }
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

export function correctRejectedForms(
  ja: string,
  original: string,
  rows: readonly NameTerm[],
  allow: (row: NameTerm) => boolean,
): { ja: string; corrections: { term: string; before: string; after: string }[] } {
  let corrected = ja;
  const corrections: { term: string; before: string; after: string }[] = [];

  for (const row of rows) {
    if (
      row.render !== "ja" ||
      row.correct !== true ||
      row.ja === undefined ||
      row.rejected === undefined ||
      row.rejected.length === 0 ||
      findNonOverlappingOccurrences(original, [row.term]).length === 0 ||
      !allow(row)
    ) {
      continue;
    }

    const accepted = row.ja;
    const rejected = Array.from(
      new Set(row.rejected.map(({ form }) => form).filter((form) => form !== "")),
    ).sort((left, right) => right.length - left.length);

    if (rejected.length === 0) {
      continue;
    }

    const pattern = new RegExp(
      [accepted, ...rejected].map(escapeRegExp).join("|"),
      "gu",
    );
    corrected = corrected.replace(pattern, (before) => {
      if (before === accepted) {
        return before;
      }

      corrections.push({ term: row.term, before, after: accepted });
      return accepted;
    });
  }

  return { ja: corrected, corrections };
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

function findAllOccurrences(
  text: string,
  terms: readonly string[],
): LocatedTerm[] {
  return findOccurrences(text, terms, true);
}

export function findNonOverlappingOccurrences(
  text: string,
  terms: readonly string[],
): LocatedTerm[] {
  return findOccurrences(text, terms, false);
}

function findOccurrences(
  text: string,
  terms: readonly string[],
  includeOverlaps: boolean,
): LocatedTerm[] {
  const occurrences: LocatedTerm[] = [];

  for (const term of normalizeTerms(terms)) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9'])`,
      "giu",
    );

    for (const match of text.matchAll(pattern)) {
      const start = match.index;

      if (start === undefined) {
        continue;
      }

      const end = start + match[0].length;

      if (
        !includeOverlaps &&
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
