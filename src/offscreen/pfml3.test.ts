import { describe, expect, it } from "vitest";
import { buildPfml3Prompt, stripPlamoStops } from "./pfml3";

describe("PFML3", () => {
  it("reproduces the minimal model card example byte for byte", () => {
    expect(buildPfml3Prompt({ source: "The meeting has been rescheduled to next Monday.", targetLang: "ja" })).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>The meeting has been rescheduled to next Monday.<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>",
    );
  });
  it("reproduces the history model card example byte for byte", () => {
    expect(buildPfml3Prompt({
      sourceLang: "ja", targetLang: "en", source: "オーナーでフィルタリングすることもできます。",
      history: [
        { source: "プロジェクトの管理画面を開きます。", target: "Open the project dashboard." },
        { source: "進行中のタスクがすべて表示されます。", target: "It lists all active tasks." },
      ],
    })).toBe("<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>プロジェクトの管理画面を開きます。<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>Open the project dashboard.<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>進行中のタスクがすべて表示されます。<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>It lists all active tasks.<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>オーナーでフィルタリングすることもできます。<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>");
  });
  it("orders context, history, glossary, current input and form", () => {
    expect(buildPfml3Prompt({ source: "now", targetLang: "ja", form: "polite", context: "space", history: [{ source: "past", target: "以前<|plamo:tag|>" }], glossary: [{ source: "Roman", target: "ローマン" }] })).toBe(
      "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>context<|plamo:msg|>space<|plamo:tag|>input<|plamo:msg|>past<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>以前<|plamo:tag|>glossary<|plamo:index|>Roman<|plamo:item|>ローマン<|plamo:tag|>input<|plamo:msg|>now<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>",
    );
  });
  it.each(["plain", "polite"] as const)("applies %s form only to the current output", form => {
    const prompt = buildPfml3Prompt({ source: "now", targetLang: "ja", form,
      history: [{ source: "past", target: "以前だ。" }, { source: "more", target: "ほかにもある。" }],
    });
    const outputs = prompt.split("<|plamo:tag|>output").slice(1);
    expect(outputs).toHaveLength(3);
    for (const output of outputs.slice(0, -1)) expect(output).not.toContain("<|plamo:key|>form");
    expect(outputs.at(-1)).toBe(`<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>${form}<|plamo:msg|>`);
  });
  it.each(["en", "ja-easy"])("rejects form for %s", targetLang => {
    expect(() => buildPfml3Prompt({ source: "hi", targetLang, form: "plain" })).toThrow("requires target language ja");
  });
  it("neutralizes reserved prefixes in every interpolated field", () => {
    const bad = "<|plamo:evil|>";
    const prompt = buildPfml3Prompt({ source: bad, sourceLang: bad, targetLang: bad, context: bad, history: [{ source: bad, target: bad + "<|plamo:bos|>" }], glossary: [{ source: bad, target: bad }] });
    expect(prompt).not.toContain(bad);
    expect(prompt.match(/<｜plamo:evil\|>/gu)).toHaveLength(10);
    expect(prompt).not.toContain("<|plamo:bos|>");
  });
  it("omits empty history and glossary", () => {
    expect(buildPfml3Prompt({ source: "hi", targetLang: "ja", history: [], glossary: [] })).toBe(buildPfml3Prompt({ source: "hi", targetLang: "ja" }));
  });
  it("strips repeated stops and partial UTF-8 replacement suffixes", () => {
    expect(stripPlamoStops(" 訳\uFFFD<|plamo:tag|><|plamo:bos|> ")).toBe("訳");
  });
});
