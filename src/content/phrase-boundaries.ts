/**
 * @license
 * Copyright 2021 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BUDOUX_JA_MODEL } from "./vendor/budoux-ja-model";

const MODEL_GROUPS: ReadonlyMap<
  string,
  ReadonlyMap<string, number>
> = new Map(
  Object.entries(BUDOUX_JA_MODEL).map(
    ([key, values]) => [
      key,
      new Map(Object.entries(values)),
    ],
  ),
);

const BASE_SCORE =
  -0.5 *
  [...MODEL_GROUPS.values()]
    .flatMap((group) => [...group.values()])
    .reduce(
      (sum, weight) => sum + weight,
      0,
    );

const UW1 = MODEL_GROUPS.get("UW1");
const UW2 = MODEL_GROUPS.get("UW2");
const UW3 = MODEL_GROUPS.get("UW3");
const UW4 = MODEL_GROUPS.get("UW4");
const UW5 = MODEL_GROUPS.get("UW5");
const UW6 = MODEL_GROUPS.get("UW6");
const BW1 = MODEL_GROUPS.get("BW1");
const BW2 = MODEL_GROUPS.get("BW2");
const BW3 = MODEL_GROUPS.get("BW3");
const TW1 = MODEL_GROUPS.get("TW1");
const TW2 = MODEL_GROUPS.get("TW2");
const TW3 = MODEL_GROUPS.get("TW3");
const TW4 = MODEL_GROUPS.get("TW4");

const EMPTY_BOUNDARIES: ReadonlySet<number> =
  new Set();

function isPureAscii(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0);

    if (
      code === undefined ||
      code > 0x7f
    ) {
      return false;
    }
  }

  return true;
}

function toCodePointBoundaries(
  text: string,
  utf16Boundaries: readonly number[],
): ReadonlySet<number> {
  if (utf16Boundaries.length === 0) {
    return EMPTY_BOUNDARIES;
  }

  const wanted = new Set(utf16Boundaries);
  const result = new Set<number>();
  let utf16Index = 0;
  let codePointIndex = 0;

  for (const character of text) {
    if (wanted.has(utf16Index)) {
      result.add(codePointIndex);
    }

    utf16Index += character.length;
    codePointIndex += 1;
  }

  return result;
}

export function findJapanesePhraseBoundaries(
  text: string,
): ReadonlySet<number> {
  if (isPureAscii(text)) {
    return EMPTY_BOUNDARIES;
  }

  const utf16Boundaries: number[] = [];

  for (
    let index = 1;
    index < text.length;
    index += 1
  ) {
    let score = BASE_SCORE;
    // NOTE: Score values in models may be negative.
    score +=
      UW1?.get(
        text.substring(index - 3, index - 2),
      ) || 0;
    score +=
      UW2?.get(
        text.substring(index - 2, index - 1),
      ) || 0;
    score +=
      UW3?.get(
        text.substring(index - 1, index),
      ) || 0;
    score +=
      UW4?.get(
        text.substring(index, index + 1),
      ) || 0;
    score +=
      UW5?.get(
        text.substring(index + 1, index + 2),
      ) || 0;
    score +=
      UW6?.get(
        text.substring(index + 2, index + 3),
      ) || 0;
    score +=
      BW1?.get(
        text.substring(index - 2, index),
      ) || 0;
    score +=
      BW2?.get(
        text.substring(index - 1, index + 1),
      ) || 0;
    score +=
      BW3?.get(
        text.substring(index, index + 2),
      ) || 0;
    score +=
      TW1?.get(
        text.substring(index - 3, index),
      ) || 0;
    score +=
      TW2?.get(
        text.substring(index - 2, index + 1),
      ) || 0;
    score +=
      TW3?.get(
        text.substring(index - 1, index + 2),
      ) || 0;
    score +=
      TW4?.get(
        text.substring(index, index + 3),
      ) || 0;

    if (score > 0) {
      utf16Boundaries.push(index);
    }
  }

  return toCodePointBoundaries(
    text,
    utf16Boundaries,
  );
}
