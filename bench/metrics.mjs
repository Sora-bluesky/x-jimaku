const FILLER_PATTERNS = [
  ["you", "know"],
  ["sort", "of"],
  ["um"],
  ["uh"],
  ["like"],
];

export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text) {
  const normalized = normalizeText(text);
  return normalized === "" ? [] : normalized.split(" ");
}

export function stripFillerTokens(tokens) {
  const filtered = [];

  for (let index = 0; index < tokens.length;) {
    const filler = FILLER_PATTERNS.find((pattern) => (
      pattern.every((token, offset) => tokens[index + offset] === token)
    ));

    if (filler) {
      index += filler.length;
    } else {
      filtered.push(tokens[index]);
      index += 1;
    }
  }

  return filtered;
}

export function levenshtein(left, right) {
  const leftItems = Array.isArray(left) ? left : Array.from(String(left));
  const rightItems = Array.isArray(right) ? right : Array.from(String(right));

  if (leftItems.length === 0) {
    return rightItems.length;
  }

  if (rightItems.length === 0) {
    return leftItems.length;
  }

  let previous = Array.from(
    { length: rightItems.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= leftItems.length; leftIndex += 1) {
    const current = [leftIndex];

    for (
      let rightIndex = 1;
      rightIndex <= rightItems.length;
      rightIndex += 1
    ) {
      const substitutionCost = leftItems[leftIndex - 1]
        === rightItems[rightIndex - 1]
        ? 0
        : 1;

      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    previous = current;
  }

  return previous[rightItems.length];
}

function calculateWer(referenceTokens, hypothesisTokens) {
  const edits = levenshtein(referenceTokens, hypothesisTokens);

  return {
    edits,
    hypothesisWords: hypothesisTokens.length,
    referenceWords: referenceTokens.length,
    value: referenceTokens.length === 0
      ? (hypothesisTokens.length === 0 ? 0 : null)
      : edits / referenceTokens.length,
  };
}

function containsTokenSequence(tokens, sequence) {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }

  for (
    let start = 0;
    start <= tokens.length - sequence.length;
    start += 1
  ) {
    if (sequence.every((token, offset) => tokens[start + offset] === token)) {
      return true;
    }
  }

  return false;
}

function nearestHypothesisToken(properNoun, hypothesisTokens) {
  if (hypothesisTokens.length === 0) {
    return {
      editDistance: null,
      nearestHypothesisToken: null,
    };
  }

  const comparisonValue = normalizeText(properNoun).replace(/\s+/g, "");
  let nearestToken = hypothesisTokens[0];
  let nearestDistance = levenshtein(comparisonValue, nearestToken);

  for (const token of hypothesisTokens.slice(1)) {
    const distance = levenshtein(comparisonValue, token);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestToken = token;
    }
  }

  return {
    editDistance: nearestDistance,
    nearestHypothesisToken: nearestToken,
  };
}

function calculateProperNounMetrics(properNouns, hypothesisTokens) {
  const matches = [];
  const misses = [];

  for (const properNoun of properNouns) {
    const properNounTokens = tokenize(properNoun);

    if (containsTokenSequence(hypothesisTokens, properNounTokens)) {
      matches.push(properNoun);
    } else {
      misses.push({
        properNoun,
        ...nearestHypothesisToken(properNoun, hypothesisTokens),
      });
    }
  }

  return {
    matches,
    misses,
    recall: properNouns.length === 0
      ? null
      : matches.length / properNouns.length,
    total: properNouns.length,
  };
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function calculateClauseMetrics(clauses) {
  const wordCounts = clauses.map((clause) => tokenize(clause).length);
  const fragmentCount = wordCounts.filter((count) => count < 4).length;
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);

  return {
    fragmentCount,
    fragmentRate: clauses.length === 0
      ? null
      : fragmentCount / clauses.length,
    stats: {
      count: clauses.length,
      meanWords: clauses.length === 0 ? 0 : totalWords / clauses.length,
      medianWords: median(wordCounts),
      wordCounts,
    },
  };
}

export function computeMetrics({
  reference,
  hypothesis,
  clauses,
  properNouns = [],
}) {
  if (!Array.isArray(clauses)) {
    throw new TypeError("clauses must be an array");
  }

  if (!Array.isArray(properNouns)) {
    throw new TypeError("properNouns must be an array");
  }

  const referenceTokens = tokenize(reference);
  const hypothesisTokens = tokenize(hypothesis);
  const filteredReferenceTokens = stripFillerTokens(referenceTokens);
  const filteredHypothesisTokens = stripFillerTokens(hypothesisTokens);

  const rawWer = calculateWer(referenceTokens, hypothesisTokens);
  const filteredWer = calculateWer(
    filteredReferenceTokens,
    filteredHypothesisTokens,
  );
  const properNounMetrics = calculateProperNounMetrics(
    properNouns,
    hypothesisTokens,
  );
  const clauseMetrics = calculateClauseMetrics(clauses);

  return {
    clauseStats: clauseMetrics.stats,
    fragmentCount: clauseMetrics.fragmentCount,
    fragmentRate: clauseMetrics.fragmentRate,
    properNounMatches: properNounMetrics.matches,
    properNounMisses: properNounMetrics.misses,
    properNounRecall: properNounMetrics.recall,
    properNounTotal: properNounMetrics.total,
    wer: rawWer.value,
    werDetails: rawWer,
    werFiltered: filteredWer.value,
    werFilteredDetails: filteredWer,
  };
}
