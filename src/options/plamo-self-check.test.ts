import { describe, expect, it, vi } from "vitest";
import { PLAMO_CHECK_SENTENCES, runPlamoSelfCheck, type PlamoGpu } from "./plamo-self-check";
import type { PlamoHost } from "../offscreen/plamo-engine";
import { PLAMO_MODELS } from "../shared/plamo-models";

function setup(gpu: PlamoGpu | undefined) {
  const report = vi.fn();
  const host = { initialize: vi.fn<PlamoHost["initialize"]>(async () => undefined), translate: vi.fn<PlamoHost["translate"]>(async () => "日本語") };
  const current = vi.fn(() => true);
  return { model: "0.8b" as const, easy: false, gpu, host, current, report, progress: vi.fn() };
}

const adapter = { info: { vendor: "test", device: "GPU" }, limits: { maxBufferSize: 1, maxStorageBufferBindingSize: 1 } };

describe("PLaMo self-check", () => {
  it.each(["gpu", "adapter"])("stops before loading when %s is missing", async missing => {
    const options = setup(missing === "gpu" ? undefined : { requestAdapter: vi.fn(async () => null) });
    await runPlamoSelfCheck(options);
    expect(options.host.initialize).not.toHaveBeenCalled();
    expect(options.host.translate).not.toHaveBeenCalled();
    expect(options.report.mock.calls.flat().join(" ")).toContain("ダウンロードせず終了");
  });
  it("reports expected bytes before load, limits without a fit rule, and three timed outputs", async () => {
    const options = setup({ requestAdapter: vi.fn(async () => adapter) });
    options.host.initialize.mockImplementation(async () => {
      expect(options.report.mock.calls[0][1]).toContain(PLAMO_MODELS["0.8b"].bytes.toLocaleString());
      expect(options.report).toHaveBeenCalledWith("maxBufferSize", "1");
    });
    await runPlamoSelfCheck(options);
    expect(options.host.initialize).toHaveBeenCalledOnce();
    expect(options.host.translate).toHaveBeenCalledTimes(3);
    expect(options.report).toHaveBeenCalledWith("アダプター情報", JSON.stringify(adapter.info));
    expect(options.report).toHaveBeenCalledWith("読込時間", expect.stringContaining(" ms"));
    for (const [index, source] of PLAMO_CHECK_SENTENCES.entries()) {
      expect(options.host.translate.mock.calls[index][1]).toContain(source);
      expect(options.report).toHaveBeenCalledWith(source, expect.stringContaining(" ms: 日本語"));
    }
  });
  it("cancels after the adapter probe before loading", async () => {
    const options = setup({ requestAdapter: vi.fn(async () => adapter) });
    options.current.mockReturnValue(false);
    await runPlamoSelfCheck(options);
    expect(options.host.initialize).not.toHaveBeenCalled();
  });
});
