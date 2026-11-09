import { afterEach, describe, expect, it, vi } from "vitest";
import { plamoVerificationStore } from "./plamo-storage";

vi.mock("@wllama/wllama", () => ({ CacheManager: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const files = new Map<string, string>();
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, "");
      }
      return {
        async getFile() { return new Blob([files.get(name)!]); },
        async createWritable() {
          return {
            async write(value: string) { files.set(name, value); },
            async close() {}, async abort() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException("missing", "NotFoundError");
    },
    async *[Symbol.asyncIterator]() { for (const name of files.keys()) yield [name, {}]; },
  };
  const getDirectoryHandle = vi.fn(async () => directory);
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle }) } });
  return { files, getDirectoryHandle };
}

describe("PLaMo verification persistence", () => {
  it("writes records to OPFS, reads the stored bytes and deletes them", async () => {
    const s = setup();
    const record = { name: "model.gguf", size: 3, sha256: "digest" };
    await plamoVerificationStore.write(record);
    expect(s.getDirectoryHandle).toHaveBeenCalledWith("plamo-verified", { create: true });
    expect(JSON.parse(s.files.get(record.name)!)).toEqual(record);
    expect(await plamoVerificationStore.read(record.name)).toEqual(record);
    s.files.set(record.name, JSON.stringify({ ...record, size: 4 }));
    expect(await plamoVerificationStore.read(record.name)).toEqual({ ...record, size: 4 });
    await plamoVerificationStore.delete(record.name);
    expect(await plamoVerificationStore.read(record.name)).toBeNull();
    await plamoVerificationStore.delete(record.name);
  });
  it("ignores malformed or misnamed records and clears orphan records", async () => {
    const s = setup();
    s.files.set("broken", "{");
    s.files.set("wrong", JSON.stringify({ name: "other", size: 3, sha256: "digest" }));
    expect(await plamoVerificationStore.read("broken")).toBeNull();
    expect(await plamoVerificationStore.read("wrong")).toBeNull();
    await plamoVerificationStore.clear();
    expect(s.files.size).toBe(0);
  });
});
