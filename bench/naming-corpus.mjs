import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const CASE_CONTEXT_TERMS = {
  tts: [],
  tts2: [
    "Roman",
    "NASA Goddard",
    "Kennedy Space Center",
    "coronagraph",
  ],
  theo: ["Anthropic", "Claude", "Opus", "Theo"],
  theo2: ["Anthropic", "Claude", "Opus", "Theo"],
  theosil: ["Anthropic", "Claude", "Opus", "Theo"],
};

const REFERENCE_FILES = [
  "live2-tts2-base-original-on-20260903-051858.json",
  "live2-tts2-base-original-on-20260903-053049.json",
  "live2-tts2-base-original-on-20260903-055344.json",
  "live2-tts2-base-original-on-20260903-061735.json",
  "live2-tts2-base-original-on-20260903-063243.json",
  "live2-tts2-base-original-on-20260903-064429.json",
  "live2-tts2-base-original-on-20260903-082811.json",
  "live2-tts2-base-original-on-20260903-083845.json",
  "live2-tts2-base-original-on-20260904-002418.json",
  "live2-tts2-base-original-on-20260904-043224.json",
  "live2-tts2-base-original-on-20260904-043759.json",
];

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const KATAKANA = /\p{Script=Katakana}/u;
const KATAKANA_FORM =
  /\p{Script=Katakana}[\p{Script=Katakana}\p{Script=Han}ー]*/gu;

class DisjointSet {
  constructor() {
    this.parents = new Map();
  }

  add(item) {
    if (!this.parents.has(item)) {
      this.parents.set(item, item);
    }
  }

  find(item) {
    this.add(item);
    const parent = this.parents.get(item);
    if (parent === item) {
      return item;
    }
    const rootItem = this.find(parent);
    this.parents.set(item, rootItem);
    return rootItem;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parents.set(rightRoot, leftRoot);
    }
  }
}

function addCount(counts, key, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left.localeCompare(right, "ja")),
  );
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lineKey(id, text, rung = "unknown") {
  return `${String(id)}\u0000${String(text)}\u0000${String(rung)}`;
}

function latinPattern(term) {
  return new RegExp(
    `(?<![A-Za-z0-9])${escapeRegex(term)}(?![A-Za-z0-9'])`,
    "giu",
  );
}

function exactPattern(form) {
  return new RegExp(escapeRegex(form), "gu");
}

function rejectedPattern(form) {
  if (!KATAKANA.test(form)) {
    return exactPattern(form);
  }
  return new RegExp(
    `(?<![\\p{Script=Katakana}ー])${escapeRegex(form)}`
      + `(?![\\p{Script=Katakana}ー])`,
    "gu",
  );
}

function findMatches(text, pattern) {
  return [...String(text).matchAll(pattern)].map((match) => match[0]);
}

function expectedFormPattern(name, expected) {
  const source = escapeRegex(expected)
    .replace(
      /(\p{Script=Latin})\s*(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])/gu,
      "$1\\s*",
    )
    .replace(
      /([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])\s*(?=\p{Script=Latin})/gu,
      "$1\\s*",
    );
  return name.render === "latin"
    ? new RegExp(
        `(?<![A-Za-z0-9])${source}(?![A-Za-z0-9'])`,
        "giu",
      )
    : new RegExp(source, "gu");
}

function matchesExpectedForm(form, name, expected) {
  return findMatches(
    form,
    expectedFormPattern(name, expected),
  ).includes(form);
}

function maskMatches(text, pattern) {
  return String(text).replace(
    pattern,
    (match) => " ".repeat(match.length),
  );
}

function countTerm(text, term) {
  return findMatches(text, latinPattern(term)).length;
}

function katakanaForms(text) {
  return [...String(text).matchAll(KATAKANA_FORM)]
    .map((match) => match[0]);
}

function cuePrefix(cueId, fallback) {
  const text = String(cueId ?? "");
  if (!text) {
    return fallback;
  }
  return text.split(":", 1)[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function scriptMixedForms(text, term) {
  const forms = [];
  const termLower = term.toLowerCase();
  const tokens = String(text).match(
    /[\p{Script=Latin}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Greek}ー]+/gu,
  ) ?? [];

  for (const token of tokens) {
    if (!KATAKANA.test(token)) {
      continue;
    }
    const hasNonLatinForeign =
      /\p{Script=Cyrillic}|\p{Script=Greek}/u.test(token);
    const latinParts =
      token.match(/\p{Script=Latin}+/gu) ?? [];
    const hasNameLatin =
      latinParts.some((part) =>
        termLower.includes(part.toLowerCase()),
      );
    // Japanese sets a Latin name flush against the next katakana word
    // (NASAゴダード). When the Latin part is the whole name, the name
    // itself is intact and the token is not a mixed form of it.
    const latinIsWholeName =
      latinParts.length === 1
      && latinParts[0].toLowerCase() === termLower;
    if (
      hasNonLatinForeign
      || (hasNameLatin && !latinIsWholeName)
    ) {
      forms.push(token);
    }
  }

  const words = term.match(/[A-Za-z0-9]+/gu) ?? [];
  if (words.length < 2) {
    return forms;
  }

  // A partially Latin multi-word name: report the span from the Latin word
  // through the Japanese run that follows it (ゴダード, 宇宙センター), not the
  // whole clause, so the form can be compared with the expected one.
  const wordAlternatives = words.map(escapeRegExp).join("|");
  // Either order: Latin words followed by a Japanese run (NASA ゴダード) or a
  // Japanese run, optionally with の, followed by the Latin words
  // (ケネディの Space Center). At least one side must be Japanese.
  const spanPattern = new RegExp(
    `(?:[\\p{Script=Katakana}\\p{Script=Han}ー々]+(?:の)?[ \u3000]?)?(?:${wordAlternatives})(?:[ \u3000]?(?:${wordAlternatives}))*(?:[ \u3000]?[\\p{Script=Katakana}\\p{Script=Han}ー々]+)?`,
    "giu",
  );
  for (const clause of String(text).split(/[。！？\n]/u)) {
    const wordsSeen = words.filter((word) =>
      latinPattern(word).test(clause),
    ).length;
    if (
      wordsSeen > 0
      && wordsSeen < words.length
      && JAPANESE.test(clause)
    ) {
      for (const match of clause.matchAll(spanPattern)) {
        if (JAPANESE.test(match[0])) {
          forms.push(match[0].trim());
        }
      }
    }
  }
  return forms;
}

function expectedFor(name) {
  if (Object.hasOwn(name, "expected")) {
    return name.expected;
  }
  if (name.render === "ja") {
    return name.ja ?? null;
  }
  if (name.render === "latin") {
    return name.term;
  }
  return null;
}

function emptyClass() {
  return {
    count: 0,
    forms: {},
    byRung: {},
  };
}

function createClasses() {
  return {
    wrongKnown: emptyClass(),
    expected: emptyClass(),
    keptLatin: emptyClass(),
    variant: emptyClass(),
    missing: {
      ...emptyClass(),
      droppedBeforeDisplay: 0,
      droppedBeforeTranslation: 0,
      onScreen: 0,
    },
  };
}

function addForms(bucket, forms, rung, allForms, formRungs) {
  for (const form of forms) {
    bucket.count += 1;
    addCount(bucket.forms, form);
    addCount(bucket.byRung, rung);
    addCount(allForms, form);
    formRungs[form] ??= {};
    addCount(formRungs[form], rung);
  }
}

function finalizeClasses(classes) {
  return Object.fromEntries(
    Object.entries(classes).map(([key, bucket]) => [
      key,
      {
        ...bucket,
        forms: sortedRecord(bucket.forms),
        byRung: sortedRecord(bucket.byRung),
      },
    ]),
  );
}

function sourceOccurrences(unit, term) {
  const occurrences = [];
  for (const line of unit.lines) {
    const count = countTerm(line.text, term);
    for (let index = 0; index < count; index += 1) {
      occurrences.push({
        lineKey: line.key,
        rung: line.rung ?? "unknown",
        missingCause: line.missingCause ?? "onScreen",
      });
    }
  }
  return occurrences;
}

function occurrenceRung(occurrences) {
  const lineKeys = new Set(
    occurrences.map((occurrence) => occurrence.lineKey),
  );
  const rungs = new Set(
    occurrences.map((occurrence) => occurrence.rung),
  );
  if (lineKeys.size > 1 && rungs.size > 1) {
    return "mixed";
  }
  return rungs.values().next().value ?? "unknown";
}

function buildLegacyUnits(run) {
  const blocks = Array.isArray(run?.display?.blocks)
    ? run.display.blocks
    : [];
  const samples = Array.isArray(run?.display?.samples)
    ? run.display.samples
    : [];
  const originalsByCue = new Map();

  for (const [index, sample] of samples.entries()) {
    if (
      typeof sample?.original !== "string"
      || !sample.original.trim()
    ) {
      continue;
    }
    const key = cuePrefix(sample.cueId, `sample-${index}`);
    originalsByCue.set(
      key,
      (originalsByCue.get(key) ?? new Set()).add(sample.original),
    );
  }

  const groups = new Map();
  for (const [index, block] of blocks.entries()) {
    const key = cuePrefix(block?.cueId, `block-${index}`);
    const group = groups.get(key) ?? {
      key,
      outputLines: [],
      sourceTexts: new Set(originalsByCue.get(key) ?? []),
    };
    const outputLines = Array.isArray(block?.lines)
      ? block.lines
      : [block?.line0, block?.line1];
    group.outputLines.push(
      ...outputLines.filter(
        (line) => typeof line === "string" && line !== "",
      ),
    );
    if (
      typeof block?.sourceText === "string"
      && block.sourceText.trim()
    ) {
      group.sourceTexts.add(block.sourceText);
    }
    groups.set(key, group);
  }

  const units = [...groups.values()].map((group) => ({
    id: `cue:${group.key}`,
    legacy: true,
    pages: [],
    lines: [...group.sourceTexts].map((text, index) => ({
      key: `legacy:${group.key}:${index}`,
      id: `${group.key}:${index}`,
      text,
      rung: "unknown",
      origin: "legacy",
      missingCause: "onScreen",
    })),
    output: group.outputLines.join("\n"),
  }));

  return {
    units,
    checksFailed: [],
    rateEligible: false,
    englishPassthroughRate: {
      num: null,
      den: null,
      rate: null,
    },
  };
}

export function buildUnits(run) {
  const display = run?.display ?? {};
  if (!Array.isArray(display.lines)) {
    return buildLegacyUnits(run);
  }

  const pages = Array.isArray(display.pages)
    ? display.pages
    : [];
  const drops = Array.isArray(display.drops)
    ? display.drops
    : [];
  const acceptedLines = new Map();
  const linesById = new Map();
  const disjointSet = new DisjointSet();

  for (const line of display.lines) {
    const key = lineKey(line?.id, line?.text, line?.rung);
    if (acceptedLines.has(key)) {
      continue;
    }
    const record = {
      key,
      node: `line:${key}`,
      id: line?.id,
      text: String(line?.text ?? ""),
      rung: String(line?.rung ?? "unknown"),
      acceptedAt: line?.acceptedAt ?? null,
    };
    acceptedLines.set(key, record);
    disjointSet.add(record.node);
    const id = String(record.id);
    const records = linesById.get(id) ?? [];
    records.push(record);
    linesById.set(id, records);
  }

  const lineIds = new Set(
    [...acceptedLines.values()].map((line) => String(line.id)),
  );
  const smallestLineId = Math.min(
    ...[...lineIds].map(Number),
  );
  let warmupPagesExcluded = 0;
  const pagesForUnits = pages.filter((page) => {
    const sources = Array.isArray(page?.sources)
      ? page.sources
      : [];
    const excluded =
      sources.length > 0
      && Number.isFinite(smallestLineId)
      && sources.every((source) =>
        !lineIds.has(String(source?.id))
        && Number(source?.id) < smallestLineId,
      );
    warmupPagesExcluded += Number(excluded);
    return !excluded;
  });

  function resolveSource(source) {
    const exact = acceptedLines.get(
      lineKey(source?.id, source?.text, source?.rung),
    );
    if (exact) {
      return exact;
    }
    return (linesById.get(String(source?.id)) ?? []).find(
      (line) => line.text === String(source?.text ?? ""),
    ) ?? null;
  }

  const pageRecords = pagesForUnits.map((page, index) => {
    const cueNode =
      `cue:${String(page?.cueId ?? `missing-${index}`)}`;
    disjointSet.add(cueNode);
    const sources = Array.isArray(page?.sources)
      ? page.sources
      : [];
    for (const source of sources) {
      const resolved = resolveSource(source);
      const sourceNode = resolved?.node
        ?? `unresolved:${lineKey(
          source?.id,
          source?.text,
          source?.rung,
        )}`;
      disjointSet.add(sourceNode);
      disjointSet.union(cueNode, sourceNode);
    }
    return { page, cueNode, sources };
  });

  const dropRecords = drops.map((drop, index) => {
    const cueNode =
      `cue:${String(drop?.cueId ?? `drop-${index}`)}`;
    disjointSet.add(cueNode);
    const sourceIds = Array.isArray(drop?.sourceIds)
      ? drop.sourceIds.map(String)
      : [];
    for (const id of sourceIds) {
      const matchingLines = linesById.get(id) ?? [];
      if (matchingLines.length === 0) {
        const unresolvedNode = `drop-unresolved:${id}`;
        disjointSet.add(unresolvedNode);
        disjointSet.union(cueNode, unresolvedNode);
      }
      for (const line of matchingLines) {
        disjointSet.union(cueNode, line.node);
      }
    }
    return { cueNode, sourceIds };
  });

  const queueDrops = (
    Array.isArray(run?.diagnostics?.devLog)
      ? run.diagnostics.devLog
      : []
  ).filter(
    (entry) =>
      entry?.data?.kind === "queue-drop"
      && typeof entry.data.text === "string",
  ).map((entry, index) => ({
    node: `queue-drop:${index}:${String(entry.data.lineId)}`,
    key: `queue-drop:${index}:${String(entry.data.lineId)}`,
    id: entry.data.lineId,
    text: entry.data.text,
    rung: "dropped-before-translation",
    origin: "offscreen-drop",
    missingCause: "droppedBeforeTranslation",
  }));

  for (const queueDrop of queueDrops) {
    disjointSet.add(queueDrop.node);
  }

  const droppedIds = new Set(
    dropRecords.flatMap((drop) => drop.sourceIds),
  );
  const unitsByRoot = new Map();

  function unitFor(node) {
    const unitRoot = disjointSet.find(node);
    if (!unitsByRoot.has(unitRoot)) {
      unitsByRoot.set(unitRoot, {
        id: unitRoot,
        legacy: false,
        pages: [],
        lines: [],
        output: "",
      });
    }
    return unitsByRoot.get(unitRoot);
  }

  for (const line of acceptedLines.values()) {
    unitFor(line.node).lines.push({
      ...line,
      origin: "accepted",
      missingCause: droppedIds.has(String(line.id))
        ? "droppedBeforeDisplay"
        : "onScreen",
    });
  }

  for (const pageRecord of pageRecords) {
    unitFor(pageRecord.cueNode).pages.push(pageRecord.page);
  }

  for (const dropRecord of dropRecords) {
    unitFor(dropRecord.cueNode);
  }

  for (const queueDrop of queueDrops) {
    unitFor(queueDrop.node).lines.push(queueDrop);
  }

  const units = [...unitsByRoot.values()];
  for (const unit of units) {
    unit.pages.sort((left, right) =>
      String(left?.appearedAt ?? "").localeCompare(
        String(right?.appearedAt ?? ""),
      ),
    );
    unit.output = unit.pages.flatMap((page) =>
      [page?.line0, page?.line1].filter(
        (line) => typeof line === "string" && line !== "",
      ),
    ).join("\n");
  }
  units.sort((left, right) => left.id.localeCompare(right.id));

  const referencedIds = new Set();
  let pageSourceMismatch = false;
  let dropSourceMissing = false;

  for (const pageRecord of pageRecords) {
    for (const source of pageRecord.sources) {
      referencedIds.add(String(source?.id));
      if (!resolveSource(source)) {
        pageSourceMismatch = true;
      }
    }
  }

  for (const dropRecord of dropRecords) {
    for (const id of dropRecord.sourceIds) {
      referencedIds.add(id);
      if (!lineIds.has(id)) {
        dropSourceMissing = true;
      }
    }
  }

  const queueDropCollision = queueDrops.some((drop) =>
    lineIds.has(String(drop.id)),
  );
  const checksFailed = [];
  if (pageSourceMismatch) {
    checksFailed.push(
      "① page source id/text is absent from display.lines",
    );
  }
  if (dropSourceMissing) {
    checksFailed.push(
      "② drop source id is absent from display.lines",
    );
  }
  if (queueDropCollision) {
    checksFailed.push(
      "③ queue-drop lineId is present in display.lines",
    );
  }
  if (lineIds.size < referencedIds.size) {
    checksFailed.push(
      "④ display.lines id set is smaller than the unit source id set",
    );
  }

  const fallbackLineKeys = new Set();
  for (const pageRecord of pageRecords) {
    if (pageRecord.page?.fallback !== true) {
      continue;
    }
    for (const source of pageRecord.sources) {
      const resolved = resolveSource(source);
      if (resolved) {
        fallbackLineKeys.add(resolved.key);
      }
    }
  }
  const passthroughDenominator = acceptedLines.size;

  return {
    units,
    checksFailed,
    warmupPagesExcluded,
    rateEligible: true,
    englishPassthroughRate: {
      num: fallbackLineKeys.size,
      den: passthroughDenominator,
      rate: passthroughDenominator === 0
        ? null
        : fallbackLineKeys.size / passthroughDenominator,
    },
  };
}

function negativeForms(units, term) {
  const tally = new Map();

  for (const unit of units) {
    const englishKnown = unit.lines.some(
      (line) => typeof line.text === "string" && line.text.trim() !== "",
    );
    if (!englishKnown) {
      continue;
    }

    const bucket = sourceOccurrences(unit, term).length > 0
      ? "with"
      : "without";
    for (const form of katakanaForms(unit.output)) {
      const counts = tally.get(form) ?? { with: 0, without: 0 };
      counts[bucket] += 1;
      tally.set(form, counts);
    }
  }

  const negative = new Set();
  for (const [form, counts] of tally) {
    if (
      counts.without > counts.with
      && counts.with + counts.without >= 3
    ) {
      negative.add(form);
    }
  }
  return negative;
}

export function classifyName(
  unitsOrAnalysis,
  name,
  options = {},
) {
  const analysis = Array.isArray(unitsOrAnalysis)
    ? {
        units: unitsOrAnalysis,
        checksFailed: options.checksFailed ?? [],
        rateEligible: options.rateEligible ?? true,
      }
    : unitsOrAnalysis;
  const units = analysis.units ?? [];
  const expected = expectedFor(name);
  const forms = {};
  const formRungs = {};
  let english = 0;

  const negativeCandidates = negativeForms(units, name.term);

  if (expected === null) {
    for (const unit of units) {
      const occurrences = sourceOccurrences(unit, name.term);
      english += occurrences.length;
      if (occurrences.length === 0) {
        continue;
      }
      const rung = occurrenceRung(occurrences);
      const observed = [
        ...findMatches(unit.output, latinPattern(name.term)),
        ...scriptMixedForms(unit.output, name.term),
        ...katakanaForms(unit.output).filter(
          (form) => !negativeCandidates.has(form),
        ),
      ];
      for (const form of observed) {
        addCount(forms, form);
        formRungs[form] ??= {};
        addCount(formRungs[form], rung);
      }
    }
    return {
      term: name.term,
      expected: null,
      english,
      forms: sortedRecord(forms),
      formRungs,
    };
  }

  const classes = createClasses();

  for (const unit of units) {
    const occurrences = sourceOccurrences(unit, name.term);
    const denominator = occurrences.length;
    english += denominator;
    if (denominator === 0) {
      continue;
    }

    const rung = occurrenceRung(occurrences);
    const termPattern = latinPattern(name.term);
    const expectedPattern = expectedFormPattern(name, expected);
    let rejectedText = maskMatches(unit.output, termPattern);
    if (typeof name.ja === "string" && name.ja) {
      rejectedText = maskMatches(
        rejectedText,
        exactPattern(name.ja),
      );
    }

    const rejectedForms = (name.rejected ?? []).flatMap((entry) => {
      const form = typeof entry === "string"
        ? entry
        : entry?.form;
      return typeof form === "string" && form
        ? findMatches(rejectedText, rejectedPattern(form))
        : [];
    });
    const wrongForms = [
      ...rejectedForms,
      ...scriptMixedForms(unit.output, name.term).filter((form) =>
        !matchesExpectedForm(form, name, expected),
      ),
    ];
    const expectedForms =
      findMatches(unit.output, expectedPattern);
    const keptLatinForms = name.render === "ja"
      ? findMatches(unit.output, termPattern)
      : [];

    let remainingText = unit.output;
    for (const form of wrongForms) {
      remainingText = maskMatches(
        remainingText,
        rejectedForms.includes(form)
          ? rejectedPattern(form)
          : exactPattern(form),
      );
    }
    remainingText = maskMatches(
      remainingText,
      expectedPattern,
    );
    remainingText = maskMatches(
      remainingText,
      termPattern,
    );
    const variantForms = katakanaForms(remainingText).filter(
      (form) => !negativeCandidates.has(form),
    );

    let available = occurrences.filter(
      (occurrence) =>
        occurrence.missingCause === "onScreen",
    ).length;
    let assigned = 0;

    function allocate(bucket, candidates) {
      const selected = candidates.slice(0, available);
      addForms(
        bucket,
        selected,
        rung,
        forms,
        formRungs,
      );
      available -= selected.length;
      assigned += selected.length;
    }

    allocate(classes.wrongKnown, wrongForms);
    allocate(classes.expected, expectedForms);
    allocate(classes.keptLatin, keptLatinForms);
    allocate(classes.variant, variantForms);

    const missingCount = denominator - assigned;
    classes.missing.count += missingCount;
    addCount(classes.missing.byRung, rung, missingCount);

    const missingOccurrences = [
      ...occurrences.filter(
        (occurrence) =>
          occurrence.missingCause !== "onScreen",
      ),
      ...occurrences.filter(
        (occurrence) =>
          occurrence.missingCause === "onScreen",
      ),
    ].slice(0, missingCount);
    for (const occurrence of missingOccurrences) {
      classes.missing[occurrence.missingCause] += 1;
    }
  }

  const ratesAvailable =
    english > 0
    && analysis.rateEligible !== false
    && (analysis.checksFailed ?? []).length === 0;
  const finalizedClasses = finalizeClasses(classes);

  return {
    term: name.term,
    expected,
    ...(name.nestedJa ? { nestedJa: name.nestedJa } : {}),
    english,
    forms: sortedRecord(forms),
    formRungs,
    classes: finalizedClasses,
    rates: {
      nameExpectedRate: ratesAvailable
        ? classes.expected.count / english
        : null,
      nameWrongKnownRate: ratesAvailable
        ? classes.wrongKnown.count / english
        : null,
      keptLatinRate: ratesAvailable
        ? classes.keptLatin.count / english
        : null,
    },
  };
}

export function takeRun(run) {
  const unit = Array.isArray(run?.display?.lines)
    ? "line"
    : "cue";
  if (run?.gatesSuppressed) {
    return {
      taken: false,
      unit,
      skippedReason:
        `gatesSuppressed: ${String(run.gatesSuppressed)}`,
    };
  }

  const error = run?.error;
  if (
    error !== undefined
    && error !== null
    && (
      typeof error !== "string"
      || !error.startsWith("display gate ")
    )
  ) {
    return {
      taken: false,
      unit,
      skippedReason: `error: ${String(error)}`,
    };
  }

  const lineCount = unit === "line"
    ? run.display.lines.length
    : Array.isArray(run?.recognition?.jaClauses)
      ? run.recognition.jaClauses.length
      : 0;
  if (lineCount < 1) {
    return {
      taken: false,
      unit,
      skippedReason:
        unit === "line"
          ? "display.lines is empty"
          : "recognition.jaClauses is empty",
    };
  }

  return {
    taken: true,
    unit,
    stopDrainTimedOut:
      run?.stopDrainTimedOut === true,
  };
}

function ranks(values) {
  const ordered = values.map((value, index) => ({
    value,
    index,
  })).sort((left, right) => left.value - right.value);
  const result = Array(values.length);
  let start = 0;

  while (start < ordered.length) {
    let end = start + 1;
    while (
      end < ordered.length
      && ordered[end].value === ordered[start].value
    ) {
      end += 1;
    }
    const midRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) {
      result[ordered[index].index] = midRank;
    }
    start = end;
  }
  return result;
}

function normalizeDirection(direction) {
  if (
    direction === "higher"
    || direction === "after-higher"
  ) {
    return "higher";
  }
  if (
    direction === "lower"
    || direction === "after-lower"
  ) {
    return "lower";
  }
  throw new Error(
    `direction must be higher or lower, got ${String(direction)}`,
  );
}

export function wilcoxonRankSumOneSided(
  before,
  after,
  direction,
) {
  const normalizedDirection =
    normalizeDirection(direction);
  if (before.length === 0 || after.length === 0) {
    throw new Error(
      "wilcoxonRankSumOneSided needs both samples",
    );
  }

  const pooled = [...before, ...after];
  const pooledRanks = ranks(pooled);
  const observed = pooledRanks.slice(before.length)
    .reduce((sum, rank) => sum + rank, 0);
  let extreme = 0;
  let combinations = 0;

  function enumerate(start, remaining, rankSum) {
    if (remaining === 0) {
      combinations += 1;
      if (
        normalizedDirection === "higher"
          ? rankSum >= observed
          : rankSum <= observed
      ) {
        extreme += 1;
      }
      return;
    }
    for (
      let index = start;
      index <= pooledRanks.length - remaining;
      index += 1
    ) {
      enumerate(
        index + 1,
        remaining - 1,
        rankSum + pooledRanks[index],
      );
    }
  }

  enumerate(0, after.length, 0);
  return extreme / combinations;
}

function validRateSample(sample) {
  return sample
    && Number.isFinite(sample.num)
    && Number.isFinite(sample.den)
    && sample.den > 0;
}

function pooledCounts(samples) {
  return samples.filter(validRateSample).reduce(
    (pooled, sample) => ({
      num: pooled.num + sample.num,
      den: pooled.den + sample.den,
    }),
    { num: 0, den: 0 },
  );
}

function distributionSummary(samples) {
  const values = samples
    .filter(validRateSample)
    .map((sample) => sample.num / sample.den)
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return {
      min: null,
      median: null,
      max: null,
    };
  }
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
  return {
    min: values[0],
    median,
    max: values.at(-1),
  };
}

export function compareRates({
  before,
  after,
  direction,
}) {
  const pooledBefore = pooledCounts(before);
  const pooledAfter = pooledCounts(after);
  const perRunMinMedianMax = {
    before: distributionSummary(before),
    after: distributionSummary(after),
  };
  if (
    before.length < 5
    || after.length < 5
    || before.some((sample) => !validRateSample(sample))
    || after.some((sample) => !validRateSample(sample))
  ) {
    return {
      verdict: "undecidable",
      p: null,
      pooledBefore,
      pooledAfter,
      perRunMinMedianMax,
    };
  }

  const p = wilcoxonRankSumOneSided(
    before.map((sample) => sample.num / sample.den),
    after.map((sample) => sample.num / sample.den),
    direction,
  );
  return {
    verdict: p < 0.05
      ? "regression"
      : "no-evidence",
    p,
    pooledBefore,
    pooledAfter,
    perRunMinMedianMax,
  };
}

function runSnapshot(run) {
  if (run?.naming?.atRun) {
    return run.naming.atRun;
  }
  // No run records its own classification yet (steps 4 and 5 add it). Until
  // then a run classified with the table it was built with is the same
  // thing, so atCurrent stands in when the table has not changed since.
  if (run?.naming?.atCurrent && run.tableChanged !== true) {
    return run.naming.atCurrent;
  }
  if (run?.naming?.names) {
    return run.naming;
  }
  return null;
}

function classCount(nameResult, className) {
  return nameResult?.classes?.[className]?.count;
}

function nameRateSamples(runs, name, className) {
  const samples = [];
  for (const run of runs) {
    const snapshot = runSnapshot(run);
    const nameResult = snapshot?.names?.[name];
    if (!nameResult) {
      samples.push(null);
      continue;
    }
    if (nameResult.english === 0) {
      continue;
    }
    const num = classCount(nameResult, className);
    const rateKey = className === "wrongKnown"
      ? "nameWrongKnownRate"
      : "nameExpectedRate";
    if (
      !Number.isFinite(num)
      || nameResult.rates?.[rateKey] === null
      || nameResult.rates?.[rateKey] === undefined
    ) {
      samples.push(null);
      continue;
    }
    samples.push({
      num,
      den: nameResult.english,
    });
  }
  return samples;
}

function passthroughSamples(runs) {
  return runs.map((run) => {
    const rate = runSnapshot(run)
      ?.englishPassthroughRate;
    return validRateSample(rate)
      ? { num: rate.num, den: rate.den }
      : null;
  });
}

export function assessChange({
  runsBefore,
  runsAfter,
  target,
}) {
  const termsModes = new Set(
    [...runsBefore, ...runsAfter]
      .map((run) => run.termsMode)
      .filter(Boolean),
  );
  if (termsModes.size !== 1) {
    return {
      target,
      overall: "undecidable",
      reason:
        "before and after must use one shared termsMode",
      items: {},
    };
  }

  let a1Invalid = false;
  let targetWrongKnown = 0;
  let targetEnglish = 0;
  for (const run of runsAfter) {
    const nameResult =
      runSnapshot(run)?.names?.[target];
    if (!nameResult) {
      a1Invalid = true;
      continue;
    }
    if (nameResult.english === 0) {
      continue;
    }
    const wrongKnown =
      classCount(nameResult, "wrongKnown");
    if (!Number.isFinite(wrongKnown)) {
      a1Invalid = true;
      continue;
    }
    targetWrongKnown += wrongKnown;
    targetEnglish += nameResult.english;
  }

  const a1 = {
    verdict: targetWrongKnown > 0
      ? "regression"
      : a1Invalid || targetEnglish === 0
        ? "undecidable"
        : "no-evidence",
    pooledAfter: {
      num: targetWrongKnown,
      den: targetEnglish,
    },
  };

  const expectedNames = new Set();
  for (const run of [...runsBefore, ...runsAfter]) {
    for (
      const [name, result]
      of Object.entries(runSnapshot(run)?.names ?? {})
    ) {
      if (
        name !== target
        && result.expected !== null
        && result.expected !== undefined
      ) {
        expectedNames.add(name);
      }
    }
  }

  const a2 = {};
  const a4 = {};
  for (const name of [...expectedNames].sort()) {
    const wrongBefore =
      nameRateSamples(runsBefore, name, "wrongKnown");
    const wrongAfter =
      nameRateSamples(runsAfter, name, "wrongKnown");
    const expectedBefore =
      nameRateSamples(runsBefore, name, "expected");
    const expectedAfter =
      nameRateSamples(runsAfter, name, "expected");
    if (
      [...wrongBefore, ...wrongAfter]
        .filter(validRateSample).length === 0
    ) {
      continue;
    }
    a2[name] = compareRates({
      before: wrongBefore,
      after: wrongAfter,
      direction: "higher",
    });
    a4[name] = compareRates({
      before: expectedBefore,
      after: expectedAfter,
      direction: "lower",
    });
  }

  const a3 = compareRates({
    before:
      nameRateSamples(runsBefore, target, "expected"),
    after:
      nameRateSamples(runsAfter, target, "expected"),
    direction: "lower",
  });
  const a5 = compareRates({
    before: passthroughSamples(runsBefore),
    after: passthroughSamples(runsAfter),
    direction: "higher",
  });

  const verdicts = [
    a1.verdict,
    ...Object.values(a2).map((result) => result.verdict),
    a3.verdict,
    ...Object.values(a4).map((result) => result.verdict),
    a5.verdict,
  ];
  const overall = verdicts.includes("regression")
    ? "regression"
    : verdicts.includes("undecidable")
      ? "undecidable"
      : "no-evidence";

  return {
    target,
    termsMode: [...termsModes][0],
    items: {
      A1: a1,
      A2: a2,
      A3: a3,
      A4: a4,
      A5: a5,
    },
    overall,
  };
}

function nestedJaForPageTerm(term, tableRows) {
  const spans = [];
  const nestedJa = [];
  const rows = tableRows
    .filter((row) =>
      row.render === "ja"
      && typeof row.ja === "string"
      && row.ja,
    )
    .sort((left, right) =>
      right.term.length - left.term.length);

  for (const row of rows) {
    let matched = false;
    for (const match of term.matchAll(latinPattern(row.term))) {
      const start = match.index;
      const end = start + match[0].length;
      if (
        spans.some((span) =>
          start < span.end && end > span.start)
      ) {
        continue;
      }
      spans.push({
        start,
        end,
        replacement: row.ja,
      });
      matched = true;
    }
    if (matched) {
      nestedJa.push({ term: row.term, ja: row.ja });
    }
  }

  let cursor = 0;
  let expected = "";
  for (const span of spans.sort((left, right) =>
    left.start - right.start)) {
    expected += term.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  expected += term.slice(cursor);
  return { expected, nestedJa };
}

function contextTermsFor(run) {
  if (Array.isArray(run?.contextTerms)) {
    return run.contextTerms;
  }
  return CASE_CONTEXT_TERMS[
    run?.caseId ?? run?.case
  ] ?? [];
}

function definitionsForRun(run, tableRows) {
  const contextTerms = contextTermsFor(run);
  const termsMode =
    run?.termsMode === "with"
    || run?.termsMode === "without"
      ? run.termsMode
      : contextTerms.length > 0
        ? "with"
        : "without";
  const definitions = new Map();

  for (const row of tableRows) {
    definitions.set(row.term, {
      ...row,
      expected:
        row.ambiguous && termsMode === "without"
          ? null
          : row.render === "ja"
            ? row.ja
            : row.term,
    });
  }

  if (termsMode === "with") {
    for (const term of contextTerms) {
      if (
        !/^\p{Lu}/u.test(term)
        || definitions.has(term)
      ) {
        continue;
      }
      const { expected, nestedJa } =
        nestedJaForPageTerm(term, tableRows);
      definitions.set(term, {
        term,
        render: "latin",
        expected,
        ...(nestedJa.length > 0 ? { nestedJa } : {}),
        pageDerived: true,
        rejected: [],
      });
    }
  }

  return {
    termsMode,
    definitions: [...definitions.values()],
  };
}

function candidateExclusions(units, definitions) {
  const excludedByName = new Map(
    definitions.map(({ term }) => [
      term,
      negativeForms(units, term),
    ]),
  );
  for (const unit of units) {
    const present = definitions.filter(
      ({ term }) => sourceOccurrences(unit, term).length > 0,
    );

    const attributed = present.map((definition) => {
      const classes =
        classifyName([unit], definition).classes ?? {};
      // Only definite attributions exclude: a variant is a katakana run that
      // merely co-occurred with the other name, and the same run co-occurs
      // with this one.
      const forms = [
        "wrongKnown",
        "expected",
        "keptLatin",
      ].flatMap((className) =>
        Object.keys(classes[className]?.forms ?? {}),
      );
      return [definition.term, forms];
    });
    for (const { term } of present) {
      for (const [otherName, forms] of attributed) {
        // A nested name (Goddard inside NASA Goddard) shares its forms with
        // the longer one by construction; only unrelated names exclude.
        if (
          otherName !== term
          && countTerm(otherName, term) === 0
          && countTerm(term, otherName) === 0
        ) {
          for (const form of forms) {
            excludedByName.get(term).add(form);
          }
        }
      }
    }
  }
  return excludedByName;
}

export function analyzeCurrent(run, tableRows) {
  const { termsMode, definitions } =
    definitionsForRun(run, tableRows);
  const unitAnalysis = buildUnits(run);
  const names = {};
  const excludedByName = candidateExclusions(
    unitAnalysis.units,
    definitions,
  );

  for (const definition of definitions) {
    names[definition.term] = {
      ...classifyName(unitAnalysis, definition),
      candidateExcludedForms: [
        ...(excludedByName.get(definition.term) ?? []),
      ].sort((left, right) =>
        left.localeCompare(right, "ja"),
      ),
    };
  }

  return {
    termsMode,
    checksFailed: unitAnalysis.checksFailed,
    warmupPagesExcluded:
      unitAnalysis.warmupPagesExcluded ?? 0,
    naming: {
      names,
      englishPassthroughRate:
        unitAnalysis.englishPassthroughRate,
    },
  };
}

function aggregateNames(runs) {
  const summaries = new Map();

  for (const run of runs) {
    if (!run.taken) {
      continue;
    }
    const names =
      run.naming?.atCurrent?.names ?? {};
    for (const [name, result] of Object.entries(names)) {
      const formEntries = Object.entries(result.forms ?? {});
      if (result.english === 0 && formEntries.length === 0) {
        continue;
      }
      const summary = summaries.get(name) ?? {
        rawForms: {},
        variants: new Set(),
        runsSeen: new Set(),
        seen: {},
      };
      summary.runsSeen.add(run.file);
      for (const [form, count] of formEntries) {
        addCount(summary.rawForms, form, count);
        summary.seen[form] ??= [];
        summary.seen[form].push({
          file: run.file,
          rungs: result.formRungs?.[form] ?? {
            unknown: count,
          },
        });
      }
      for (
        const form
        of Object.keys(
          result.classes?.variant?.forms ?? {},
        )
      ) {
        summary.variants.add(form);
      }
      summaries.set(name, summary);
    }
  }

  return Object.fromEntries(
    [...summaries.entries()]
      .sort(([left], [right]) =>
        left.localeCompare(right, "ja"),
      )
      .map(([name, summary]) => [
        name,
        {
          rawForms: sortedRecord(summary.rawForms),
          variants: [...summary.variants].sort(
            (left, right) =>
              left.localeCompare(right, "ja"),
          ),
          runsSeen: [...summary.runsSeen].sort(),
          seen: sortedRecord(summary.seen),
        },
      ]),
  );
}

function sameForm(actual, expected) {
  if (/[A-Za-z]/u.test(expected)) {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}

function escapeMarkdown(text) {
  return String(text)
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

export function renderCandidates({
  runs = [],
  nameRows = [],
} = {}) {
  const names = aggregateNames(runs);
  const expectedByName = new Map(
    nameRows.map((row) => [
      row.term,
      row.render === "ja" ? row.ja : row.term,
    ]),
  );
  const rowByName = new Map(
    nameRows.map((row) => [row.term, row]),
  );
  const excludedByName = new Map();

  for (const run of runs) {
    for (
      const [name, result]
      of Object.entries(
        run.naming?.atCurrent?.names ?? {},
      )
    ) {
      const excluded =
        excludedByName.get(name) ?? new Set();
      for (
        const form
        of result.candidateExcludedForms ?? []
      ) {
        excluded.add(form);
      }
      excludedByName.set(name, excluded);
      if (
        !expectedByName.has(name)
        && result.expected !== null
        && result.expected !== undefined
      ) {
        expectedByName.set(name, result.expected);
      }
    }
  }

  const candidates = [];
  for (const [name, summary] of Object.entries(names)) {
    const excluded =
      excludedByName.get(name) ?? new Set();
    const forms = Object.entries(summary.rawForms).filter(
      ([form]) =>
        !excluded.has(form)
        && !nameRows.some((row) =>
          row.term !== name
          && [row.term, row.ja].some(
            (otherForm) =>
              typeof otherForm === "string"
              && sameForm(form, otherForm),
          ),
        ),
    );
    const expected = expectedByName.get(name);
    const differs = expected !== undefined
      && forms.some(([form]) => !sameForm(form, expected));
    const scriptMixed = forms.some(([form]) =>
      scriptMixedForms(form, name).length > 0,
    );
    if (
      forms.length < 2
      && !differs
      && !scriptMixed
    ) {
      continue;
    }

    const total = forms.reduce(
      (sum, [, count]) => sum + count,
      0,
    );
    const row = rowByName.get(name);
    const ambiguous = row?.ambiguous
      ? ", ambiguous: true"
      : "";
    const skeleton =
      `{ term: ${JSON.stringify(name)}, render: "ja", `
      + `ja: "", confidence: "verified", source: ""`
      + `${ambiguous} },`;
    const formText = forms
      .sort((left, right) =>
        right[1] - left[1]
        || left[0].localeCompare(right[0], "ja"),
      )
      .map(([form, count]) =>
        `\`${escapeMarkdown(form)}\` (${count})`,
      )
      .join("<br>");
    const seenByFile = {};
    for (const [form] of forms) {
      for (const seen of summary.seen[form] ?? []) {
        seenByFile[seen.file] ??= {};
        for (const [rung, count] of Object.entries(seen.rungs)) {
          addCount(seenByFile[seen.file], rung, count);
        }
      }
    }
    const seenText = Object.keys(seenByFile)
      .sort()
      .map((file) => {
        const rungs = Object.entries(seenByFile[file])
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([rung, count]) => `${rung}:${count}`)
          .join(", ");
        return `${escapeMarkdown(file)} (${rungs})`;
      })
      .join("<br>");

    candidates.push({
      name,
      total,
      formText,
      seenText,
      skeleton,
    });
  }

  candidates.sort((left, right) =>
    right.total - left.total
    || left.name.localeCompare(right.name, "ja"),
  );

  const lines = [
    "# 名前表記の候補票",
    "",
    "この票は候補と観測件数だけを示します。正しい表記は決めません。",
    "",
  ];
  if (candidates.length === 0) {
    lines.push("候補はありません。", "");
    return lines.join("\n");
  }

  lines.push(
    "| 名前 | 候補表記と件数 | 走行と段 | NameTerm雛形 |",
    "|---|---|---|---|",
  );
  for (const candidate of candidates) {
    lines.push(
      `| ${escapeMarkdown(candidate.name)}`
      + ` | ${candidate.formText}`
      + ` | ${candidate.seenText}`
      + ` | \`${escapeMarkdown(candidate.skeleton)}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function referenceCounts(records) {
  const recordsByFile = new Map(
    records
      .filter((record) => record.run)
      .map((record) => [record.file, record.run]),
  );
  const missingFiles = REFERENCE_FILES.filter(
    (file) => !recordsByFile.has(file),
  );
  const text = REFERENCE_FILES.flatMap((file) => {
    const run = recordsByFile.get(file);
    return (run?.display?.blocks ?? []).flatMap((block) =>
      Array.isArray(block?.lines)
        ? block.lines
        : [block?.line0, block?.line1].filter(Boolean),
    );
  }).join("\n");
  const count = (pattern) =>
    (text.match(pattern) ?? []).length;

  return {
    runFiles: REFERENCE_FILES,
    missingFiles,
    complete: missingFiles.length === 0,
    rawOutputSideCounts: {
      Roman: {
        latin: count(
          /(?<![A-Za-z])Roman(?![A-Za-z])/giu,
        ),
        romaFamilyExcludingRomanKatakana:
          count(/ローマ(?!ン)/gu),
        romanKatakana: count(/ローマン/gu),
        romanShort: count(/ロマン/gu),
      },
      Goddard: {
        latin: count(
          /(?<![A-Za-z])Goddard(?![A-Za-z])/giu,
        ),
        goddard: count(/ゴッダード/gu),
        goddoDard: count(/ゴッドダード/gu),
        godard: count(/ゴダード/gu),
      },
      "Kennedy Space Center": {
        latin: count(
          /(?<![A-Za-z])Kennedy\s+Space\s+Center(?![A-Za-z])/giu,
        ),
        ja: count(/ケネディ宇宙センター/gu),
        mixed: count(
          /ケネディ(?:の)?\s*Space(?:[\s、・]*)Center/giu,
        ),
      },
    },
  };
}

function normalizeTableRows(rows) {
  return rows.map((row) => {
    if (
      !row
      || typeof row.term !== "string"
      || !row.term
    ) {
      throw new Error("name table contains an invalid term");
    }
    const render = row.render ?? "latin";
    if (render !== "latin" && render !== "ja") {
      throw new Error(
        `name table has invalid render for ${row.term}`,
      );
    }
    if (
      render === "ja"
      && (typeof row.ja !== "string" || !row.ja)
    ) {
      throw new Error(
        `name table is missing ja for ${row.term}`,
      );
    }
    return {
      ...row,
      render,
      rejected: Array.isArray(row.rejected)
        ? row.rejected
        : [],
    };
  });
}

async function copyAndLoadNameTable() {
  const sourcePath = path.join(
    root,
    "src",
    "offscreen",
    "glossary.data.ts",
  );
  const workDirectory = path.join(here, "work");
  const copyPath = path.join(
    workDirectory,
    "name-table.mts",
  );
  mkdirSync(workDirectory, { recursive: true });
  copyFileSync(sourcePath, copyPath);

  const sourceBytes = readFileSync(sourcePath);
  const copiedBytes = readFileSync(copyPath);
  if (!sourceBytes.equals(copiedBytes)) {
    throw new Error(
      "name table copy check failed: copied bytes differ",
    );
  }

  const nameTableHash = createHash("sha256")
    .update(sourceBytes)
    .digest("hex");
  // The copy is imported as TypeScript with the types stripped by Node
  // itself (design §2-5); that needs Node 22.18 or newer, unflagged.
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error(
      `naming-corpus needs Node 22.18 or newer to import the name table copy (running ${process.versions.node})`,
    );
  }
  const tableModule = await import(
    `${pathToFileURL(copyPath).href}?sha256=${nameTableHash}`,
  );
  const rows =
    tableModule.NAME_TERMS
    ?? tableModule.KEEP_LATIN_TERMS;
  if (!Array.isArray(rows)) {
    throw new Error(
      "name table copy check failed: NAME_TERMS or KEEP_LATIN_TERMS is required",
    );
  }

  return {
    nameTableHash,
    nameRows: normalizeTableRows(rows),
  };
}

function resolveBenchPath(flag, value) {
  const resolved = path.resolve(value);
  const benchPrefix = `${path.resolve(here)}${path.sep}`;
  if (!resolved.startsWith(benchPrefix)) {
    throw new Error(
      `${flag} must point inside bench/ (got ${resolved})`,
    );
  }
  return resolved;
}

export function parseArgs(argv) {
  const options = {
    resultsDirectory: path.join(here, "results"),
    outputDirectory: null,
    caseName: null,
    beforeRevision: null,
    afterRevision: null,
    target: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === "--results"
      || flag === "--out"
      || flag === "--case"
      || flag === "--before"
      || flag === "--after"
      || flag === "--target"
    ) {
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      if (flag === "--results") {
        options.resultsDirectory =
          resolveBenchPath(flag, value);
      } else if (flag === "--out") {
        options.outputDirectory =
          resolveBenchPath(flag, value);
      } else if (flag === "--case") {
        options.caseName = value;
      } else if (flag === "--before") {
        options.beforeRevision = value;
      } else if (flag === "--after") {
        options.afterRevision = value;
      } else {
        options.target = value;
      }
      continue;
    }
    throw new Error(`unknown option ${flag}`);
  }

  options.outputDirectory ??=
    options.resultsDirectory;
  const assessmentFlags = [
    options.beforeRevision,
    options.afterRevision,
    options.target,
  ].filter((value) => value !== null).length;
  if (assessmentFlags !== 0 && assessmentFlags !== 3) {
    throw new Error(
      "--before, --after, and --target must be used together",
    );
  }
  return options;
}

function readResultRecords(
  resultsDirectory,
  caseName,
) {
  const files = readdirSync(resultsDirectory)
    .filter((file) => /^live2-.*\.json$/u.test(file))
    .sort();
  if (files.length === 0) {
    throw new Error("no live2 result files were found");
  }

  const records = [];
  let readable = 0;
  for (const file of files) {
    try {
      const run = JSON.parse(
        readFileSync(
          path.join(resultsDirectory, file),
          "utf8",
        ),
      );
      const runCase = run.caseId ?? run.case ?? null;
      if (caseName && runCase !== caseName) {
        continue;
      }
      readable += 1;
      records.push({ file, run });
    } catch (error) {
      if (!caseName) {
        records.push({
          file,
          parseError:
            `JSON parse failed: ${String(error)}`,
        });
      }
    }
  }

  if (readable === 0) {
    throw new Error(
      caseName
        ? `no readable live2 result files for case ${caseName}`
        : "no live2 result file could be read",
    );
  }
  return records;
}

function buildCorpus(
  records,
  nameRows,
  nameTableHash,
  caseName,
) {
  const runs = [];

  for (const record of records) {
    if (!record.run) {
      runs.push({
        file: record.file,
        case: null,
        displayConfig: null,
        termsMode: null,
        build: null,
        nameTableHash: null,
        unit: null,
        taken: false,
        skippedReason: record.parseError,
      });
      continue;
    }

    const run = record.run;
    const intake = takeRun(run);
    const runCase = run.caseId ?? run.case ?? null;
    const contextTerms = contextTermsFor(run);
    const termsMode =
      run.termsMode === "with"
      || run.termsMode === "without"
        ? run.termsMode
        : contextTerms.length > 0
          ? "with"
          : "without";
    const runHash =
      typeof run.nameTableHash === "string"
        ? run.nameTableHash
        : null;
    const corpusRun = {
      file: record.file,
      case: runCase,
      displayConfig:
        run.displayConfig
        ?? run.gates?.displayConfig
        ?? null,
      termsMode,
      build: run.build ?? null,
      nameTableHash: runHash,
      tableChanged: runHash !== nameTableHash,
      unit: intake.unit,
      taken: intake.taken,
      stopDrainTimedOut:
        run.stopDrainTimedOut === true,
    };

    if (!intake.taken) {
      corpusRun.skippedReason =
        intake.skippedReason;
      runs.push(corpusRun);
      continue;
    }

    const current = analyzeCurrent(run, nameRows);
    corpusRun.warmupPagesExcluded =
      current.warmupPagesExcluded;
    if (current.checksFailed.length > 0) {
      corpusRun.checksFailed =
        current.checksFailed;
    }
    corpusRun.naming = {
      ...(run.naming
        ? { atRun: run.naming }
        : {}),
      atCurrent: current.naming,
    };
    runs.push(corpusRun);
  }

  runs.sort((left, right) =>
    String(left.case).localeCompare(String(right.case))
    || left.file.localeCompare(right.file),
  );

  const cases = {};
  for (
    const runCase
    of [...new Set(
      runs.map((run) => run.case).filter(Boolean),
    )].sort()
  ) {
    const caseRuns = runs.filter(
      (run) => run.case === runCase,
    );
    cases[runCase] = {
      runs: caseRuns.map((run) => run.file),
      names: aggregateNames(caseRuns),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    nameTableHash,
    runs,
    names: aggregateNames(runs),
    cases,
    ...(caseName === null || caseName === "tts2"
      ? {
          reference: {
            "tts2-original-on-11":
              referenceCounts(records),
          },
        }
      : {}),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const {
    nameTableHash,
    nameRows,
  } = await copyAndLoadNameTable();
  const records = readResultRecords(
    options.resultsDirectory,
    options.caseName,
  );
  const corpus = buildCorpus(
    records,
    nameRows,
    nameTableHash,
    options.caseName,
  );
  const candidates = renderCandidates({
    runs: corpus.runs,
    nameRows,
  });

  mkdirSync(options.outputDirectory, {
    recursive: true,
  });
  writeFileSync(
    path.join(
      options.outputDirectory,
      "naming-corpus.json",
    ),
    `${JSON.stringify(corpus, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(
      options.outputDirectory,
      "naming-candidates.md",
    ),
    candidates,
    "utf8",
  );

  if (options.beforeRevision) {
    const assessment = assessChange({
      runsBefore: corpus.runs.filter(
        (run) =>
          run.taken
          && run.build?.revision
            === options.beforeRevision,
      ),
      runsAfter: corpus.runs.filter(
        (run) =>
          run.taken
          && run.build?.revision
            === options.afterRevision,
      ),
      target: options.target,
    });
    console.log(JSON.stringify(assessment, null, 2));
  }
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[naming-corpus] ${error instanceof Error
        ? error.message
        : String(error)}`,
    );
    process.exitCode = 1;
  });
}
