import { describe, expect, it, vi } from "vitest";
import { clearPlamoCache, verifiedPlamoBlob, type PlamoCache, type VerificationStore } from "./plamo-integrity";

describe("PLaMo integrity and deletion", () => {
  it("hashes chunks without reading the whole Blob into a buffer", async () => {
    const blob = new Blob(["abc"]);
    vi.spyOn(blob, "arrayBuffer").mockRejectedValue(new Error("whole-file read forbidden"));
    vi.spyOn(blob, "stream").mockImplementation(() => new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        controller.enqueue(new TextEncoder().encode("bc"));
        controller.close();
      },
    }));
    const cache = { getNameFromURL: async () => "entry", open: async () => blob } as unknown as PlamoCache;
    const records = { read: async () => null, delete: vi.fn(), write: vi.fn() } as unknown as VerificationStore;
    const progress = vi.fn();
    await expect(verifiedPlamoBlob(cache, records, "url", {
      bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    }, progress)).resolves.toBe(blob);
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
    expect(progress.mock.calls).toEqual([[0, 3, "hash"], [1, 3, "hash"], [3, 3, "hash"]]);
  });
  it("deletes only PLaMo GGUFs and all verification records, including orphans", async () => {
    const entries = ["abc_plamo-3-translate-0.8b-Q4_K_M.gguf", "old_plamo-3-translate-2b-Q4_K_M.gguf", "whisper.onnx", "other.gguf", "notes-plamo-3-translate-test.gguf"];
    const cache = { list: async () => entries.map(name => ({ name })), delete: vi.fn() } as unknown as PlamoCache;
    const records = { delete: vi.fn(), clear: vi.fn() } as unknown as VerificationStore;
    await clearPlamoCache(cache, records);
    expect(cache.delete).toHaveBeenCalledTimes(2);
    expect(records.delete).toHaveBeenCalledTimes(2);
    for (const name of entries.slice(0, 2)) {
      expect(cache.delete).toHaveBeenCalledWith(name);
      expect(records.delete).toHaveBeenCalledWith(name);
    }
    expect(records.clear).toHaveBeenCalledOnce();
  });
});
