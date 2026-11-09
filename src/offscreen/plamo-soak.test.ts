import { afterEach, describe, expect, it, vi } from "vitest";
import { PlamoSoak, isPlamoSoakRequest } from "./plamo-soak";

describe("PLaMo soak message boundary", () => {
  const id = "extension-id";
  const sender = { id, url: `chrome-extension://${id}/options.html` };
  const start = { t: "OFF_DEV_PLAMO_SOAK", action: "start", model: "0.8b", contextTerms: ["Roman"] };
  it("accepts only the extension options document and valid requests", () => {
    expect(isPlamoSoakRequest(start, sender, id)).toBe(true);
    expect(isPlamoSoakRequest({ t: start.t, action: "translate", id: 0, text: "Roman is ready." }, sender, id)).toBe(true);
    expect(isPlamoSoakRequest({ t: start.t, action: "stop" }, sender, id)).toBe(true);
    for (const untrusted of [
      { id, url: "http://127.0.0.1:8123/options.html" },
      { id, url: "https://x.com/home" },
      { id: "other", url: sender.url },
      { id, url: `chrome-extension://${id}/offscreen.html` },
      { id }, {},
    ]) expect(isPlamoSoakRequest(start, untrusted, id)).toBe(false);
    for (const invalid of [null, { ...start, model: "invalid" }, { ...start, contextTerms: [3] },
      { t: start.t, action: "translate", id: -1, text: "hi" }, { t: start.t, action: "translate", id: 0, text: " " }]) {
      expect(isPlamoSoakRequest(invalid, sender, id)).toBe(false);
    }
  });
});


afterEach(() => vi.unstubAllGlobals());
it("soaks through the product worker host with capture glossary and translation history", async () => {
  const prompts: string[] = [];
  class FakeWorker extends EventTarget {
    postMessage(message: { t: string; id?: number; prompt?: string; model?: string }) {
      if (message.t === "PLAMO_TRANSLATE") prompts.push(message.prompt!);
      const data = message.t === "PLAMO_INIT"
        ? { t: "PLAMO_READY", model: message.model, loadMs: 1 }
        : { t: "PLAMO_RESULT", id: message.id, text: "ローマン望遠鏡" };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data })));
    }
    terminate() {}
  }
  vi.stubGlobal("Worker", FakeWorker);
  const soak = new PlamoSoak();
  expect(await soak.handle({ t: "OFF_DEV_PLAMO_SOAK", action: "start", model: "0.8b", contextTerms: ["Quasar"] })).toMatchObject({ ready: true });
  expect(await soak.handle({ t: "OFF_DEV_PLAMO_SOAK", action: "translate", id: 0, text: "Roman and Quasar." })).toMatchObject({ fallback: false, timeout: false, wallMs: expect.any(Number) });
  await soak.handle({ t: "OFF_DEV_PLAMO_SOAK", action: "translate", id: 1, text: "Roman is ready." });
  expect(prompts[0]).toContain("<|plamo:index|>Quasar<|plamo:item|>Quasar");
  expect(prompts[0]).toContain("<|plamo:index|>Roman<|plamo:item|>ローマン");
  expect(prompts[1]).toContain("Roman and Quasar.");
  expect(prompts[1]).toContain("ローマン望遠鏡");
  expect(await soak.handle({ t: "OFF_DEV_PLAMO_SOAK", action: "stop" })).toMatchObject({ devLog: expect.any(Array) });
  await expect(soak.handle({ t: "OFF_DEV_PLAMO_SOAK", action: "translate", id: 2, text: "Roman." })).rejects.toThrow("not ready");
});
