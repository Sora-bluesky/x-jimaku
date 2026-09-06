/**
 * Terminology for English-to-Japanese captions.
 *
 * A Japanese source decides each name row. A sourced Japanese form is rendered
 * in Japanese; keeping the Latin spelling is also a decision that needs a
 * source. Legacy Latin rows carry an explicit migration marker until their
 * per-row sources are verified.
 *
 * Technical terms remain separate because they are context-dependent guidance,
 * not deterministic name replacements.
 *
 * The failures this exists to stop were all measured in bench/results: Opus
 * came out as オプス, オパウス and even オпус (mixed Cyrillic); Hugging Face as
 * ハルキング・フェイス; Roman, the telescope, as ローマ, the city; and Goddard
 * as ゴダード宇宙科学研究所, an institute that does not exist.
 */

export interface RejectedForm {
  readonly form: string;
  readonly reason: string;
}

export interface NameTerm {
  readonly term: string;
  readonly render: "latin" | "ja";
  readonly ja?: string;
  readonly ambiguous?: true;
  readonly confidence: "verified" | "conventional";
  readonly source: string;
  /**
   * Known wrong forms used only for regression detection. The aggregator masks
   * `ja` before matching these forms, so a rejected substring cannot count
   * inside the accepted rendering.
   */
  readonly rejected?: readonly RejectedForm[];
}

export const LEGACY_SOURCE =
  "unverified: carried over from KEEP_LATIN_TERMS (2026-09-03); the header pointed at platform.claude.com/docs/ja without per-row URLs";

export const NAME_TERMS: readonly NameTerm[] = [
  { term: "Anthropic", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Claude", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Opus", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Sonnet", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Haiku", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Fable", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Mythos", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "OpenAI", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "ChatGPT", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "GPT", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Codex", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "Google", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "DeepMind", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Gemini", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "xAI", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Grok", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Meta", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "Llama", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "Mistral", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "Cursor", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "GitHub", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Copilot", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "Hugging Face", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "NVIDIA", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "Clerk", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "NASA", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  {
    term: "Nancy Grace Roman Space Telescope",
    render: "ja",
    ja: "ナンシー・グレイス・ローマン宇宙望遠鏡",
    confidence: "conventional",
    source: "https://www.isas.jaxa.jp/topics/003741.html",
  },
  {
    term: "Roman Space Telescope",
    render: "ja",
    ja: "ローマン宇宙望遠鏡",
    confidence: "conventional",
    source: "https://www.isas.jaxa.jp/topics/003741.html",
  },
  {
    term: "Roman",
    render: "ja",
    ja: "ローマン",
    ambiguous: true,
    confidence: "conventional",
    source: "https://www.isas.jaxa.jp/topics/003741.html",
    rejected: [
      { form: "ローマ", reason: "誤義: 都市のローマ" },
      { form: "ロマン", reason: "出典に無い綴り" },
    ],
  },
  {
    term: "Kennedy Space Center",
    render: "ja",
    ja: "ケネディ宇宙センター",
    confidence: "conventional",
    source: "https://spaceinfo.jaxa.jp/ja/ksc.html",
  },
  {
    term: "Goddard Space Flight Center",
    render: "ja",
    ja: "ゴダード宇宙飛行センター",
    confidence: "conventional",
    source: "https://satnavi.jaxa.jp/gpmdpr_special/column/2013/post1118.html",
  },
  {
    term: "Goddard",
    render: "ja",
    ja: "ゴダード",
    confidence: "conventional",
    source: "https://satnavi.jaxa.jp/gpmdpr_special/column/2013/post1118.html",
    rejected: [
      { form: "ゴッダード", reason: "出典に無い綴り" },
      { form: "ゴッドダード", reason: "出典に無い綴り" },
    ],
  },
  { term: "API", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "LLM", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
  { term: "RAG", render: "latin", ambiguous: true, confidence: "verified", source: LEGACY_SOURCE },
  { term: "GPU", render: "latin", confidence: "verified", source: LEGACY_SOURCE },
];

export interface GlossaryTerm {
  readonly term: string;
  readonly ja: string;
  readonly confidence: "verified" | "conventional";
}

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  { term: "agentic workflow", ja: "エージェント型ワークフロー", confidence: "verified" },
  { term: "extended thinking", ja: "拡張思考", confidence: "verified" },
  { term: "context window", ja: "コンテキストウィンドウ", confidence: "verified" },
  { term: "neural network", ja: "ニューラルネットワーク", confidence: "verified" },
  { term: "machine learning", ja: "機械学習", confidence: "verified" },
  { term: "open weights", ja: "オープンウェイト", confidence: "verified" },
  { term: "open source", ja: "オープンソース", confidence: "conventional" },
  { term: "fine-tuning", ja: "ファインチューニング", confidence: "verified" },
  { term: "hallucination", ja: "ハルシネーション", confidence: "verified" },
  { term: "quantization", ja: "量子化", confidence: "verified" },
  { term: "distillation", ja: "蒸留", confidence: "conventional" },
  { term: "embedding", ja: "埋め込み", confidence: "verified" },
  { term: "throughput", ja: "スループット", confidence: "conventional" },
  { term: "checkpoint", ja: "チェックポイント", confidence: "conventional" },
  { term: "benchmark", ja: "ベンチマーク", confidence: "conventional" },
  { term: "evaluation", ja: "評価", confidence: "conventional" },
  { term: "reasoning", ja: "推論", confidence: "verified" },
  { term: "inference", ja: "推論", confidence: "verified" },
  { term: "latency", ja: "レイテンシ", confidence: "verified" },
  { term: "dataset", ja: "データセット", confidence: "verified" },
  { term: "training", ja: "学習", confidence: "conventional" },
  { term: "prompt", ja: "プロンプト", confidence: "verified" },
  { term: "agent", ja: "エージェント", confidence: "verified" },
  { term: "token", ja: "トークン", confidence: "verified" },
  { term: "model", ja: "モデル", confidence: "verified" },
];
