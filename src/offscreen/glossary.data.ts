/**
 * Terminology for English-to-Japanese captions.
 *
 * Two rules, both from the project owner: names of models, products and
 * organisations stay in Latin script, and technical terms use the Japanese a
 * Japanese engineer would actually write.
 *
 * Every entry marked `verified` was checked against a page that was opened —
 * mostly Anthropic's own Japanese documentation at platform.claude.com/docs/ja.
 * Entries marked `conventional` are established practice in Japanese technical
 * writing but were not pinned to a specific page. Nothing here is a guess.
 *
 * The failures this exists to stop were all measured in bench/results: Opus
 * came out as オプス, オパウス and even オпус (mixed Cyrillic); Hugging Face as
 * ハルキング・フェイス; Roman, the telescope, as ローマ, the city; and Goddard
 * as ゴダード宇宙科学研究所, an institute that does not exist.
 */

export interface KeepLatinTerm {
  readonly term: string;
  /**
   * True when the word is also ordinary English. Anthropic's model names are
   * all common nouns, so "opus", "sonnet", "haiku", "fable" and "mythos" carry
   * their everyday meanings too, and a caption about poetry must not come out
   * with "Haiku" sitting in Latin script. The rule for these is conditional on
   * the term naming the product, which only the sentence can decide.
   */
  readonly ambiguous?: true;
}

export const KEEP_LATIN_TERMS: readonly KeepLatinTerm[] = [
  { term: "Anthropic" },
  { term: "Claude" },
  { term: "Opus", ambiguous: true },
  { term: "Sonnet", ambiguous: true },
  { term: "Haiku", ambiguous: true },
  { term: "Fable", ambiguous: true },
  { term: "Mythos", ambiguous: true },
  { term: "OpenAI" },
  { term: "ChatGPT" },
  { term: "GPT" },
  { term: "Codex", ambiguous: true },
  { term: "Google" },
  { term: "DeepMind" },
  { term: "Gemini", ambiguous: true },
  { term: "xAI" },
  { term: "Grok" },
  { term: "Meta", ambiguous: true },
  { term: "Llama", ambiguous: true },
  { term: "Mistral", ambiguous: true },
  { term: "Cursor", ambiguous: true },
  { term: "GitHub" },
  { term: "Copilot", ambiguous: true },
  { term: "Hugging Face" },
  { term: "NVIDIA" },
  { term: "Clerk", ambiguous: true },
  { term: "NASA" },
  { term: "Goddard" },
  { term: "Roman", ambiguous: true },
  { term: "Kennedy Space Center" },
  { term: "API" },
  { term: "LLM" },
  { term: "RAG", ambiguous: true },
  { term: "GPU" },
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
