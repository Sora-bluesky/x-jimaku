// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializePlamoPanel } from "./plamo-panel";
import { CAPTURE_STATE_STORAGE_KEY } from "../shared/state";

const fake = vi.hoisted(() => ({
  list: vi.fn(), remove: vi.fn(), clearRecords: vi.fn(), deleteRecord: vi.fn(),
  initialize: vi.fn(), translate: vi.fn(), dispose: vi.fn(),
}));
vi.mock("../shared/plamo-storage", () => ({
  createPlamoCache: () => ({ list: fake.list, delete: fake.remove }),
  plamoVerificationStore: { delete: fake.deleteRecord, clear: fake.clearRecords },
  withPlamoCacheLock: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock("../offscreen/plamo-engine", () => ({ WorkerPlamoHost: class {
  initialize = fake.initialize;
  translate = fake.translate;
  dispose = fake.dispose;
} }));

function setup() {
  vi.resetAllMocks();
  fake.list.mockResolvedValue([
    { name: "abc_plamo-3-translate-0.8b-Q4_K_M.gguf", size: 123 },
    { name: "whisper.onnx", size: 999 },
  ]);
  fake.translate.mockResolvedValue("訳");
  const state = { status: "idle", updatedAt: new Date().toISOString() };
  const get = vi.fn(async () => ({ [CAPTURE_STATE_STORAGE_KEY]: state }));
  vi.stubGlobal("chrome", { storage: { session: { get }, onChanged: { addListener: vi.fn() } } });
  document.body.innerHTML = `
    <select id="model"><option>0.8b</option></select><select id="style"><option>standard</option></select>
    <button id="plamo-check"></button><button id="plamo-delete-cache"></button><button id="plamo-refresh-cache"></button>
    <p id="plamo-expected-bytes"></p><p id="plamo-check-status"></p><table><tbody id="plamo-check-results"></tbody></table>
    <pre id="plamo-cache-results"></pre><p id="plamo-capture-note"></p>`;
  const panel = initializePlamoPanel(document.getElementById("model") as HTMLSelectElement, document.getElementById("style") as HTMLSelectElement);
  return { panel, get, check: document.getElementById("plamo-check") as HTMLButtonElement };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("PLaMo options panel", () => {
  it("lists only PLaMo bytes and deletes both model data and verification records", async () => {
    setup();
    await vi.waitFor(() => expect(document.getElementById("plamo-cache-results")?.textContent).toContain("合計: 123 bytes"));
    expect(document.getElementById("plamo-cache-results")?.textContent).not.toContain("whisper");
    document.getElementById("plamo-delete-cache")!.click();
    await vi.waitFor(() => expect(fake.clearRecords).toHaveBeenCalledOnce());
    expect(fake.remove).toHaveBeenCalledExactlyOnceWith("abc_plamo-3-translate-0.8b-Q4_K_M.gguf");
    expect(fake.deleteRecord).toHaveBeenCalledExactlyOnceWith("abc_plamo-3-translate-0.8b-Q4_K_M.gguf");
  });
  it("disables checks while capture is active or unknown", async () => {
    const s = setup();
    expect(s.check.disabled).toBe(true);
    await vi.waitFor(() => expect(s.check.disabled).toBe(false));
    for (const status of ["starting", "loadingModel", "running", "stopping"]) {
      s.panel.setCapture({ status, updatedAt: new Date().toISOString() });
      expect(s.check.disabled).toBe(true);
    }
    s.panel.setCapture(undefined);
    expect(s.check.disabled).toBe(true);
    expect(fake.initialize).not.toHaveBeenCalled();
  });
  it("terminates a running diagnostic host on capture start", async () => {
    const s = setup();
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 1, maxStorageBufferBindingSize: 1 } }) } });
    let release!: () => void;
    fake.initialize.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(s.check.disabled).toBe(false));
    s.check.click();
    await vi.waitFor(() => expect(fake.initialize).toHaveBeenCalledOnce());
    s.panel.setCapture({ status: "starting", updatedAt: new Date().toISOString() });
    expect(fake.dispose).toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(document.getElementById("plamo-check-status")?.textContent).toContain("キャプチャ開始"));
    expect(fake.translate).not.toHaveBeenCalled();
  });
});
