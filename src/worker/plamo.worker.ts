import { createPlamoCache, plamoVerificationStore, withPlamoCacheLock } from "../shared/plamo-storage";
import { Wllama } from "@wllama/wllama";
import { isPlamoWorkerInputMessage, type PlamoWorkerOutputMessage } from "../shared/messages";
import { PlamoRuntime } from "./plamo-runtime";

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: PlamoWorkerOutputMessage): void;
}

const scope = globalThis as unknown as WorkerScope;
const runtime = new PlamoRuntime({
  records: plamoVerificationStore,
  withCacheLock: withPlamoCacheLock,
  createWllama: () => new Wllama({ default: new URL("/wllama/wllama.wasm", self.location.origin).href }, { allowOffline: true, cacheManager: createPlamoCache() }),
  async hasWebGpu() {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
    return gpu !== undefined && await gpu.requestAdapter() !== null;
  },
  post: message => scope.postMessage(message),
});

scope.addEventListener("message", event => {
  if (isPlamoWorkerInputMessage(event.data)) void runtime.handle(event.data);
});
