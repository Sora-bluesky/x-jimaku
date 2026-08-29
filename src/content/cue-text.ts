export const MAX_CUE_UNITS = 28;
export const MAX_LINE_UNITS = 14;

const MIN_CUE_SEGMENT_CHARACTERS = 5;
const MIN_LINE_SEGMENT_CHARACTERS = 2;
const MAX_ORPHAN_CUE_CHARACTERS = 4;
const JAPANESE_PARTICLES:
  readonly string[] = [
    "から",
    "まで",
    "より",
    "は",
    "が",
    "を",
    "に",
    "で",
    "と",
    "へ",
    "の",
    "も",
    "て",
  ];
const SENTENCE_BOUNDARY_CHARACTER =
  /[。！？!?]/u;
const CLAUSE_BOUNDARY_CHARACTER =
  /[、,\s]/u;
const JAPANESE_PUNCTUATION_CHARACTER =
  /[。！？!?、,]/u;
const JAPANESE_PARTICLE_START_CHARACTER =
  /[はがをにでとへのもかまよて]/u;
const KATAKANA_CHARACTER =
  /[\p{Script=Katakana}ー]/u;
const HIRAGANA_CHARACTER =
  /\p{Script=Hiragana}/u;

interface ForbiddenSuffix {
  readonly suffix: string;
  readonly continuation: string;
  readonly particle: string;
}

// A one-character suffix such as で is ambiguous with a real particle.
// Veto it only when the continuation completes at a clause edge.
const FORBIDDEN_SUFFIXES:
  readonly ForbiddenSuffix[] = [
    {
      suffix: "で",
      continuation: "す",
      particle: "で",
    },
    {
      suffix: "で",
      continuation: "した",
      particle: "で",
    },
    {
      suffix: "で",
      continuation: "も",
      particle: "で",
    },
  ];

export function splitCueText(
  text: string,
  maxUnits: number = MAX_CUE_UNITS,
): string[] {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim();

  if (normalized === "") {
    return [];
  }

  const characters = Array.from(normalized);
  const protectedRanges =
    findProtectedUrlRanges(normalized);
  const parts: string[] = [];
  let start = 0;

  while (start < characters.length) {
    const end =
      findMaximumUnitBoundary(
        characters,
        start,
        maxUnits,
      );

    if (end >= characters.length) {
      const tail =
        characters.slice(start).join("").trim();

      if (tail !== "") {
        parts.push(tail);
      }
      break;
    }

    let target = end;

    if (
      segmentCharacterCount(
        characters,
        end,
        characters.length,
      ) <= MAX_ORPHAN_CUE_CHARACTERS
    ) {
      target = findOrphanSafeTarget(
        characters,
        start,
        end,
      );
    }

    const boundary = Math.min(
      end,
      findNaturalTextBoundary(
        normalized,
        characters,
        start,
        target,
        MIN_CUE_SEGMENT_CHARACTERS,
        protectedRanges,
      ),
    );
    const part = characters
      .slice(start, boundary)
      .join("")
      .trim();

    if (part !== "") {
      parts.push(part);
    }

    start = boundary;

    while (
      characters[start] !== undefined &&
      /\s/u.test(characters[start] ?? "")
    ) {
      start += 1;
    }
  }

  return parts;
}

export function wrapCueText(
  text: string,
  maxLineUnits: number =
    MAX_LINE_UNITS,
): string {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim();

  if (
    normalized === "" ||
    displayUnits(normalized) <=
      maxLineUnits
  ) {
    return normalized;
  }

  const characters = Array.from(normalized);
  const protectedRanges =
    findProtectedUrlRanges(normalized);
  const lines: string[] = [];
  let start = 0;

  while (start < characters.length) {
    const remainingText = characters
      .slice(start)
      .join("");
    const remainingUnits =
      displayUnits(remainingText);

    if (remainingUnits <= maxLineUnits) {
      lines.push(remainingText);
      break;
    }

    const maximumLineBoundary =
      findMaximumUnitBoundary(
        characters,
        start,
        maxLineUnits,
      );
    const fitsInTwoLines =
      remainingUnits <=
      maxLineUnits * 2;
    const target = fitsInTwoLines
      ? findMaximumUnitBoundary(
          characters,
          start,
          remainingUnits / 2,
        )
      : maximumLineBoundary;
    const minimumLineBoundary =
      fitsInTwoLines
        ? findMinimumRemainderBoundary(
            characters,
            start,
            maxLineUnits,
          )
        : start + 1;
    const suggestedBoundary =
      findNaturalTextBoundary(
        normalized,
        characters,
        start,
        target,
        MIN_LINE_SEGMENT_CHARACTERS,
        protectedRanges,
        minimumLineBoundary,
        maximumLineBoundary,
      );
    const boundary = Math.min(
      maximumLineBoundary,
      Math.max(
        minimumLineBoundary,
        suggestedBoundary,
      ),
    );

    lines.push(
      characters
        .slice(start, boundary)
        .join(""),
    );
    start = boundary;
  }

  return lines.join("\n");
}

function findMinimumRemainderBoundary(
  characters: readonly string[],
  start: number,
  maxUnits: number,
): number {
  let units = 0;
  let boundary = characters.length;

  while (boundary > start) {
    const character =
      characters[boundary - 1] ?? "";
    const nextUnits =
      units + characterUnits(character);

    if (nextUnits > maxUnits) {
      break;
    }

    units = nextUnits;
    boundary -= 1;
  }

  return Math.max(
    start + 1,
    boundary,
  );
}

function findMaximumUnitBoundary(
  characters: readonly string[],
  start: number,
  maxUnits: number,
): number {
  let units = 0;
  let end = start;

  while (end < characters.length) {
    const character =
      characters[end] ?? "";
    const nextUnits =
      units + characterUnits(character);

    if (nextUnits > maxUnits) {
      break;
    }

    units = nextUnits;
    end += 1;
  }

  return end;
}

function findOrphanSafeTarget(
  characters: readonly string[],
  start: number,
  target: number,
): number {
  let redistributed = target;

  while (
    redistributed > start + 1 &&
    segmentCharacterCount(
      characters,
      redistributed,
      characters.length,
    ) <= MAX_ORPHAN_CUE_CHARACTERS
  ) {
    redistributed -= 1;
  }

  return redistributed;
}

function segmentCharacterCount(
  characters: readonly string[],
  start: number,
  end: number,
): number {
  return Array.from(
    characters
      .slice(start, end)
      .join("")
      .trim(),
  ).length;
}

function findNaturalTextBoundary(
  text: string,
  characters: readonly string[],
  start: number,
  target: number,
  minimumSegmentCharacters: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
  minimumBoundary: number = start + 1,
  maximumBoundaryLimit: number = target,
): number {
  let bestBoundary: number | null = null;
  let bestEffectiveDistance =
    Number.POSITIVE_INFINITY;
  let bestDistance =
    Number.POSITIVE_INFINITY;

  const maximumBoundary = Math.min(
    maximumBoundaryLimit,
    characters.length - 1,
  );

  for (
    let boundary = Math.max(
      start + 1,
      minimumBoundary,
    );
    boundary <= maximumBoundary;
    boundary += 1
  ) {
    if (
      !isSegmentBoundaryAllowed(
        text,
        characters,
        start,
        boundary,
        minimumSegmentCharacters,
        ranges,
      )
    ) {
      continue;
    }

    const bonus =
      naturalBoundaryBonus(
        characters,
        start,
        boundary,
      );

    if (bonus === null) {
      continue;
    }

    const distance =
      Math.abs(boundary - target);
    const effectiveDistance =
      distance - bonus;

    if (
      effectiveDistance <
        bestEffectiveDistance ||
      (
        effectiveDistance ===
          bestEffectiveDistance &&
        (
          distance < bestDistance ||
          (
            distance === bestDistance &&
            (
              bestBoundary === null ||
              boundary < bestBoundary
            )
          )
        )
      )
    ) {
      bestBoundary = boundary;
      bestEffectiveDistance =
        effectiveDistance;
      bestDistance = distance;
    }
  }

  return (
    bestBoundary ??
    findFallbackCueBoundary(
      text,
      characters,
      start,
      target,
      minimumSegmentCharacters,
      ranges,
      minimumBoundary,
      maximumBoundaryLimit,
    )
  );
}

function naturalBoundaryBonus(
  characters: readonly string[],
  start: number,
  boundary: number,
): number | null {
  const previous =
    characters[boundary - 1] ?? "";

  if (
    SENTENCE_BOUNDARY_CHARACTER.test(
      previous,
    )
  ) {
    return 6;
  }

  if (
    CLAUSE_BOUNDARY_CHARACTER.test(
      previous,
    )
  ) {
    return 3;
  }

  if (
    !endsWithJapaneseParticle(
      characters,
      start,
      boundary,
    )
  ) {
    return null;
  }

  const next = characters[boundary] ?? "";

  if (
    JAPANESE_PARTICLE_START_CHARACTER.test(
      next,
    ) ||
    JAPANESE_PUNCTUATION_CHARACTER.test(
      next,
    )
  ) {
    return null;
  }

  return 1;
}

export function endsWithJapaneseParticle(
  characters: readonly string[],
  start: number,
  boundary: number,
): boolean {
  return JAPANESE_PARTICLES.some(
    (particle) => {
      const particleCharacters =
        Array.from(particle);
      const particleStart =
        boundary -
        particleCharacters.length;

      if (
        particleStart < start ||
        !particleCharacters.every(
          (character, index) =>
            characters[
              particleStart + index
            ] === character,
        )
      ) {
        return false;
      }

      if (
        isForbiddenParticleBoundary(
          characters,
          start,
          boundary,
          particle,
        )
      ) {
        return false;
      }

      return !(
        particleCharacters.length === 1 &&
        HIRAGANA_CHARACTER.test(
          characters[particleStart - 1] ?? "",
        )
      );
    },
  );
}

function isForbiddenParticleBoundary(
  characters: readonly string[],
  start: number,
  boundary: number,
  particle: string,
): boolean {
  const before = characters
    .slice(start, boundary)
    .join("");
  const after = characters
    .slice(boundary)
    .join("");

  return FORBIDDEN_SUFFIXES.some(
    ({
      suffix,
      continuation,
      particle: shadowedParticle,
    }) => {
      if (
        shadowedParticle !== particle ||
        !before.endsWith(suffix) ||
        !after.startsWith(continuation)
      ) {
        return false;
      }

      const continuationLength =
        Array.from(continuation).length;
      const next =
        characters[
          boundary +
          continuationLength
        ] ?? "";

      return (
        next === "" ||
        next === "が" ||
        JAPANESE_PUNCTUATION_CHARACTER.test(
          next,
        )
      );
    },
  );
}

function isSegmentBoundaryAllowed(
  text: string,
  characters: readonly string[],
  start: number,
  boundary: number,
  minimumSegmentCharacters: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
): boolean {
  return (
    segmentCharacterCount(
      characters,
      start,
      boundary,
    ) >= minimumSegmentCharacters &&
    segmentCharacterCount(
      characters,
      boundary,
      characters.length,
    ) >= minimumSegmentCharacters &&
    !isCharacterBoundaryProtected(
      text,
      characters,
      boundary,
      ranges,
    ) &&
    !isInsideKatakanaRun(
      characters,
      boundary,
    )
  );
}

function isInsideKatakanaRun(
  characters: readonly string[],
  boundary: number,
): boolean {
  return (
    KATAKANA_CHARACTER.test(
      characters[boundary - 1] ?? "",
    ) &&
    KATAKANA_CHARACTER.test(
      characters[boundary] ?? "",
    )
  );
}

function findFallbackCueBoundary(
  text: string,
  characters: readonly string[],
  start: number,
  target: number,
  minimumSegmentCharacters: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
  minimumBoundary: number = start + 1,
  maximumBoundaryLimit: number = target,
): number {
  let nearestBoundary: number | null = null;
  let nearestDistance =
    Number.POSITIVE_INFINITY;
  const maximumBoundary = Math.min(
    maximumBoundaryLimit,
    characters.length - 1,
  );

  for (
    let boundary = Math.max(
      start + 1,
      minimumBoundary,
    );
    boundary <= maximumBoundary;
    boundary += 1
  ) {
    if (
      !isSegmentBoundaryAllowed(
        text,
        characters,
        start,
        boundary,
        minimumSegmentCharacters,
        ranges,
      )
    ) {
      continue;
    }

    const distance =
      Math.abs(boundary - target);

    if (
      distance < nearestDistance ||
      (
        distance === nearestDistance &&
        (
          nearestBoundary === null ||
          boundary < nearestBoundary
        )
      )
    ) {
      nearestBoundary = boundary;
      nearestDistance = distance;
    }
  }

  if (nearestBoundary !== null) {
    return nearestBoundary;
  }

  return findConventionalCueBoundary(
    text,
    characters,
    start,
    maximumBoundaryLimit,
    ranges,
  );
}

function findConventionalCueBoundary(
  text: string,
  characters: readonly string[],
  start: number,
  target: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
): number {
  const minimum = start + 1;
  const maximum = characters.length - 1;

  for (
    let boundary = Math.min(target, maximum);
    boundary >= minimum;
    boundary -= 1
  ) {
    if (
      !isCharacterBoundaryProtected(
        text,
        characters,
        boundary,
        ranges,
      )
    ) {
      return boundary;
    }
  }

  for (
    let boundary =
      Math.max(minimum, target + 1);
    boundary <= maximum;
    boundary += 1
  ) {
    if (
      !isCharacterBoundaryProtected(
        text,
        characters,
        boundary,
        ranges,
      )
    ) {
      return boundary;
    }
  }

  return Math.min(
    characters.length,
    Math.max(start + 1, target),
  );
}

export function displayUnits(
  text: string,
): number {
  let units = 0;

  for (const character of text) {
    units += characterUnits(character);
  }

  return units;
}

function characterUnits(
  character: string,
): number {
  return /[\u0000-\u00ff]/u.test(
    character,
  )
    ? 0.5
    : 1;
}

function findProtectedUrlRanges(
  text: string,
): ReadonlyArray<
  readonly [start: number, end: number]
> {
  const ranges:
    Array<readonly [number, number]> = [];
  const expression =
    /(?:https?:\/\/|www\.)\S+/giu;

  for (
    let match = expression.exec(text);
    match !== null;
    match = expression.exec(text)
  ) {
    ranges.push([
      match.index,
      match.index + match[0].length,
    ]);
  }

  return ranges;
}

function isCharacterBoundaryProtected(
  text: string,
  characters: readonly string[],
  boundary: number,
  ranges: ReadonlyArray<
    readonly [start: number, end: number]
  >,
): boolean {
  const prefix = characters
    .slice(0, boundary)
    .join("");
  const codeUnitBoundary =
    prefix.length;

  return ranges.some(
    ([start, end]) =>
      codeUnitBoundary > start &&
      codeUnitBoundary < end &&
      end <= text.length,
  );
}

