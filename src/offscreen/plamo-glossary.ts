import { renderNameTerm, selectGlossaryMatches } from "./glossary";
import type { Pfml3Pair } from "./pfml3";

export function selectPlamoGlossary(clause: string, contextTerms: readonly string[] = []): Pfml3Pair[] {
  const matches = selectGlossaryMatches(clause);
  const pairs = [
    ...matches.keepLatin.map(entry => ({ source: entry.term, target: renderNameTerm(entry.term) })),
    ...matches.glossary.map(entry => ({ source: entry.term, target: entry.ja })),
  ];
  const covered = new Set(pairs.map(pair => pair.source.toLowerCase()));
  for (const value of contextTerms) {
    const term = value.trim();
    if (!term || covered.has(term.toLowerCase())) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (!new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(clause)) continue;
    pairs.push({ source: term, target: term });
    covered.add(term.toLowerCase());
  }
  return pairs;
}
