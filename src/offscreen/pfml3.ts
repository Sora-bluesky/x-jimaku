export interface Pfml3Pair {
  source: string;
  target: string;
}

export interface Pfml3Options {
  source: string;
  sourceLang?: string;
  targetLang: string;
  form?: "plain" | "polite";
  context?: string;
  history?: readonly Pfml3Pair[];
  glossary?: readonly Pfml3Pair[];
}

function neutralize(value: string): string {
  return value.replaceAll("<|plamo:", "<｜plamo:");
}

export function stripPlamoStops(value: string): string {
  return value.trim().replace(/(?:<\|plamo:(?:tag|bos)\|>\s*|\uFFFD)+$/u, "").trim();
}

export function buildPfml3Prompt(options: Pfml3Options): string {
  if (options.form !== undefined && options.targetLang !== "ja") {
    throw new TypeError("PFML3 form requires target language ja");
  }
  const lang = (value?: string): string => value === undefined
    ? ""
    : `<|plamo:key|>lang<|plamo:val|>${neutralize(value)}`;
  const input = (value: string): string =>
    `<|plamo:tag|>input${lang(options.sourceLang)}<|plamo:msg|>${neutralize(value)}`;
  const output = (form?: Pfml3Options["form"]): string =>
    `<|plamo:tag|>output${lang(options.targetLang)}${form === undefined ? "" : `<|plamo:key|>form<|plamo:val|>${neutralize(form)}`}<|plamo:msg|>`;
  const glossary = options.glossary ?? [];
  return "<|plamo:tag|>dataset<|plamo:msg|>translation"
    + (options.context ? `<|plamo:tag|>context<|plamo:msg|>${neutralize(options.context)}` : "")
    + (options.history ?? []).map(pair => input(pair.source) + output() + neutralize(stripPlamoStops(pair.target))).join("")
    + (glossary.length === 0 ? "" : "<|plamo:tag|>glossary"
      + glossary.map(pair => `<|plamo:index|>${neutralize(pair.source)}<|plamo:item|>${neutralize(pair.target)}`).join(""))
    + input(options.source) + output(options.form);
}
