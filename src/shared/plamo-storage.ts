import { CacheManager } from "@wllama/wllama";
import type { VerificationStore, VerifiedModel } from "./plamo-integrity";

async function cacheDirectory(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle("cache", { create: true });
}

async function removeFile(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try { await directory.removeEntry(name); }
  catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
}

// Pin OPFS: wllama's optional COS backend cannot enumerate or delete model data.
export function createPlamoCache(): CacheManager {
  return new CacheManager([{
    isSupported: () => typeof navigator.storage?.getDirectory === "function",
    async read(key: string) {
      try { return await (await (await cacheDirectory()).getFileHandle(key)).getFile(); }
      catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return null;
        throw error;
      }
    },
    async write(key: string, stream: ReadableStream) {
      const file = await (await cacheDirectory()).getFileHandle(key, { create: true });
      await stream.pipeTo(await file.createWritable());
    },
    async getSize(key: string) { return (await this.read(key))?.size ?? -1; },
    async list() {
      const entries: { key: string; size: number }[] = [];
      for await (const [key, handle] of await cacheDirectory()) {
        if (handle.kind === "file") entries.push({ key, size: (await (handle as FileSystemFileHandle).getFile()).size });
      }
      return entries;
    },
    async delete(key: string) { await removeFile(await cacheDirectory(), key); },
  }]);
}

async function recordsDirectory(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle("plamo-verified", { create: true });
}

export const plamoVerificationStore: VerificationStore = {
  async read(name) {
    try {
      const file = await (await recordsDirectory()).getFileHandle(name);
      const value: unknown = JSON.parse(await (await file.getFile()).text());
      if (typeof value !== "object" || value === null) return null;
      const record = value as Partial<VerifiedModel>;
      return record.name === name && typeof record.size === "number" && typeof record.sha256 === "string"
        ? record as VerifiedModel : null;
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof DOMException && error.name === "NotFoundError")) return null;
      throw error;
    }
  },
  async write(record) {
    const file = await (await recordsDirectory()).getFileHandle(record.name, { create: true });
    const writable = await file.createWritable();
    try { await writable.write(JSON.stringify(record)); await writable.close(); }
    catch (error) { await writable.abort(); throw error; }
  },
  async delete(name) { await removeFile(await recordsDirectory(), name); },
  async clear() {
    const directory = await recordsDirectory();
    for await (const [name] of directory) await removeFile(directory, name);
  },
};

export function withPlamoCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  return navigator.locks.request("x-jimaku-plamo-cache", operation);
}
