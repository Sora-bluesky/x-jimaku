import { sha256 } from "@noble/hashes/sha2.js";

export interface VerifiedModel {
  name: string;
  size: number;
  sha256: string;
}

export interface VerificationStore {
  read(name: string): Promise<VerifiedModel | null>;
  write(record: VerifiedModel): Promise<void>;
  delete(name: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PlamoCache {
  getNameFromURL(url: string): Promise<string>;
  getSize(name: string): Promise<number>;
  open(name: string): Promise<Blob | null>;
  download(url: string, options: { progressCallback(progress: { loaded: number; total: number }): void }): Promise<void>;
  list(): Promise<{ name: string; size: number; metadata: { originalURL: string } }[]>;
  delete(name: string): Promise<void>;
}

export function isPlamoCacheEntry(name: string): boolean {
  return /(?:^|_)plamo-3-translate-.*\.gguf$/iu.test(name);
}

export async function deletePlamoEntry(cache: PlamoCache, records: VerificationStore, name: string): Promise<void> {
  await records.delete(name);
  await cache.delete(name);
}

export async function clearPlamoCache(cache: PlamoCache, records: VerificationStore): Promise<void> {
  for (const entry of await cache.list()) {
    if (isPlamoCacheEntry(entry.name)) await deletePlamoEntry(cache, records, entry.name);
  }
  await records.clear();
}

export async function verifiedPlamoBlob(
  cache: PlamoCache, records: VerificationStore, url: string,
  expected: { bytes: number; sha256: string },
  progress: (loaded: number, total: number, phase: "download" | "hash") => void,
): Promise<Blob> {
  const name = await cache.getNameFromURL(url);
  let blob = await cache.open(name);
  const record = await records.read(name);
  if (blob !== null && blob.size === expected.bytes && record?.name === name
    && record.size === blob.size && record.sha256 === expected.sha256) return blob;
  await records.delete(name);
  if (blob === null || blob.size !== expected.bytes) {
    if (blob !== null) await deletePlamoEntry(cache, records, name);
    await cache.download(url, { progressCallback: ({ loaded, total }) => progress(loaded, total, "download") });
    blob = await cache.open(name);
  }
  if (blob === null || blob.size !== expected.bytes) {
    await deletePlamoEntry(cache, records, name);
    throw new Error("PLaMo cached model byte size does not match the pinned catalog");
  }
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  let loaded = 0;
  progress(0, blob.size, "hash");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      loaded += value.byteLength;
      progress(loaded, blob.size, "hash");
    }
    const digest = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== expected.sha256) {
      await deletePlamoEntry(cache, records, name);
      throw new Error("PLaMo model SHA-256 hash did not match the pinned catalog");
    }
    await records.write({ name, size: blob.size, sha256: digest });
    return blob;
  } finally {
    reader.releaseLock();
    hash.destroy();
  }
}
