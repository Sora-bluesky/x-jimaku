import { WorkerPlamoHost } from "../offscreen/plamo-engine";
import { clearPlamoCache, isPlamoCacheEntry } from "../shared/plamo-integrity";
import { PLAMO_MODELS, isPlamoModel } from "../shared/plamo-models";
import { createPlamoCache, plamoVerificationStore, withPlamoCacheLock } from "../shared/plamo-storage";
import { CAPTURE_STATE_STORAGE_KEY, isCaptureState } from "../shared/state";
import { runPlamoSelfCheck, type PlamoGpu } from "./plamo-self-check";

export function initializePlamoPanel(model: HTMLSelectElement, style: HTMLSelectElement): { setCapture(value: unknown): void } {
  const check = document.getElementById("plamo-check") as HTMLButtonElement;
  const remove = document.getElementById("plamo-delete-cache") as HTMLButtonElement;
  const refresh = document.getElementById("plamo-refresh-cache") as HTMLButtonElement;
  const expected = document.getElementById("plamo-expected-bytes")!;
  const status = document.getElementById("plamo-check-status")!;
  const results = document.getElementById("plamo-check-results")!;
  const cacheResults = document.getElementById("plamo-cache-results")!;
  const captureNote = document.getElementById("plamo-capture-note")!;
  const cache = createPlamoCache();
  let captureIdle = false;
  let stateVersion = 0;
  let busy = false;
  let host: WorkerPlamoHost | null = null;

  function updateButtons(): void {
    check.disabled = busy || !captureIdle;
    remove.disabled = busy;
    refresh.disabled = busy;
    captureNote.textContent = captureIdle ? "自己診断中にキャプチャが始まると診断を終了します。" : "キャプチャ中、または状態を確認できない間は自己診断を実行できません。";
  }

  function setCapture(value: unknown): void {
    stateVersion++;
    captureIdle = isCaptureState(value) && (value.status === "idle" || value.status === "error");
    if (!captureIdle && host) {
      const stopped = host;
      host = null;
      stopped.dispose();
      status.textContent = "キャプチャ開始のため自己診断を終了しました。";
    }
    updateButtons();
  }

  async function readCapture(): Promise<void> {
    const version = stateVersion;
    const values = await chrome.storage.session.get(CAPTURE_STATE_STORAGE_KEY);
    if (version === stateVersion) setCapture(values[CAPTURE_STATE_STORAGE_KEY]);
  }

  function updateExpected(): void {
    if (isPlamoModel(model.value)) expected.textContent = `未保存の場合のダウンロード容量: ${PLAMO_MODELS[model.value].bytes.toLocaleString()} bytes`;
  }

  async function refreshCache(): Promise<void> {
    try {
      const entries = await withPlamoCacheLock(async () => (await cache.list()).filter(entry => isPlamoCacheEntry(entry.name)));
      const lines = entries.map(entry => {
        const label = Object.entries(PLAMO_MODELS).find(([, item]) => entry.name.endsWith(`_${item.file}`))?.[0] ?? "旧モデル";
        return `${label}: ${entry.size.toLocaleString()} bytes — ${entry.name}`;
      });
      cacheResults.textContent = [...lines, `合計: ${entries.reduce((sum, entry) => sum + entry.size, 0).toLocaleString()} bytes`].join("\n");
    } catch (error) { cacheResults.textContent = `キャッシュの確認に失敗しました: ${String(error)}`; }
  }

  remove.addEventListener("click", () => { void (async () => {
    busy = true; updateButtons();
    try {
      await withPlamoCacheLock(() => clearPlamoCache(cache, plamoVerificationStore));
      await refreshCache();
    } catch (error) { cacheResults.textContent = `キャッシュの削除に失敗しました: ${String(error)}`; }
    finally { busy = false; updateButtons(); }
  })(); });
  refresh.addEventListener("click", () => { void refreshCache(); });
  check.addEventListener("click", () => { void (async () => {
    if (busy || !isPlamoModel(model.value)) return;
    const selected = model.value;
    const easy = style.value === "easy";
    busy = true; updateButtons();
    results.replaceChildren();
    status.textContent = "実行環境を確認しています…";
    let checking: WorkerPlamoHost | null = null;
    try {
      await readCapture();
      if (!captureIdle) { status.textContent = "キャプチャ中、または状態を確認できないため実行できません。"; return; }
      checking = new WorkerPlamoHost();
      host = checking;
      await runPlamoSelfCheck({
        model: selected, easy,
        gpu: (navigator as Navigator & { gpu?: PlamoGpu }).gpu,
        host: checking,
        current: () => host === checking && captureIdle,
        progress: message => { status.textContent = message; },
        report(label, value) {
          const row = document.createElement("tr");
          const heading = document.createElement("th"); heading.textContent = label;
          const cell = document.createElement("td"); cell.textContent = value;
          row.append(heading, cell); results.append(row);
        },
      });
      if (host === checking) status.textContent = "自己診断を終了しました。結果をご確認ください。";
    } catch (error) {
      if (checking === null || host === checking) status.textContent = `自己診断に失敗しました: ${String(error)}`;
    } finally {
      checking?.dispose();
      if (host === checking) host = null;
      busy = false; updateButtons();
      await refreshCache();
    }
  })(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[CAPTURE_STATE_STORAGE_KEY]) setCapture(changes[CAPTURE_STATE_STORAGE_KEY].newValue);
    if (area === "sync") queueMicrotask(updateExpected);
  });
  window.addEventListener("pagehide", () => { host?.dispose(); });
  model.addEventListener("change", updateExpected);
  updateExpected(); updateButtons();
  void readCapture().catch(() => setCapture(undefined));
  void refreshCache();
  return { setCapture };
}
