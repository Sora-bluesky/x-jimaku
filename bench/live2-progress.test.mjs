import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { WorkerPlamoHost } from "../src/offscreen/plamo-engine.ts";
import { createPlamoReadiness } from "./live2-config.mjs";

const source = readFileSync(new URL("./live2.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
afterEach(() => vi.unstubAllGlobals());

function installRelay() {
  const window = new EventTarget();
  const origin = "https://bench.invalid";
  const installation = source.match(/  await page\.evaluate\(\(\) => \{\n    window\.__devLog = \[\];[\s\S]*?\n  \}\);/u);
  expect(installation).not.toBeNull();
  runInNewContext(installation[0].replace("await ", ""), {
    window, location: { origin }, Date,
    page: { evaluate: callback => callback() },
  });
  return {
    snapshot: () => ({ loadedBytes: window.__plamoLoadedBytes, hashedBytes: window.__plamoHashedBytes, running: false }),
    receive(message) {
      window.dispatchEvent(Object.assign(new Event("message"), {
        source: window, origin, data: { t: "OFF_DEV_LOG", message },
      }));
    },
  };
}

it.each(["download", "hash"])("relays real host %s progress and still detects a stall", async phase => {
  const relay = installRelay();
  let worker;
  vi.stubGlobal("Worker", class extends EventTarget {
    constructor() { super(); worker = this; }
    postMessage() {}
    terminate() {}
    emit(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  });
  const host = new WorkerPlamoHost();
  const logs = [];
  const initialized = host.initialize("8b", message => { logs.push(message); relay.receive(message); });
  await Promise.resolve();
  const observe = createPlamoReadiness({ timeoutMs: 120000, startedAtMs: 0 });
  try {
    worker.emit({ t: "PLAMO_PROGRESS", phase: "download", loaded: 5300000000, total: 5300000000 });
    expect(observe(relay.snapshot(), 60000).progressed).toBe(true);
    for (let step = 1; step <= 5; step += 1) {
      const loaded = phase === "hash" ? step * 1000000 : 5300000000 + step * 1000000;
      worker.emit({ t: "PLAMO_PROGRESS", phase, loaded, total: 5400000000 });
      expect(logs.at(-1)).toBe(`PLaMo ${phase === "hash" ? "sha256" : "download"}: ${loaded}/5400000000 bytes`);
      expect(observe(relay.snapshot(), 60000 + step * 60000)).toMatchObject({ ready: false, progressed: true });
    }
    worker.emit({ t: "PLAMO_PROGRESS", phase, loaded: 1, total: 5400000000 });
    expect(observe(relay.snapshot(), 420000).progressed).toBe(false);
    expect(() => observe(relay.snapshot(), 480000)).toThrow("readiness stalled");
    worker.emit({ t: "PLAMO_READY", model: "8b", loadMs: 1 });
    await initialized;
    expect(observe({ ...relay.snapshot(), path: "plamo", running: true }, 480000).ready).toBe(true);
  } finally {
    host.dispose();
    await initialized.catch(() => {});
  }
});

it.each(["0.8b", "2b", "8b"])("prints PLaMo settings with size %s", plamoModel => {
  const statement = source.split("\n").find(line => line.includes("console.error(`[live2] settings applied;"));
  expect(statement).toBeDefined();
  const error = vi.fn();
  runInNewContext(statement, { console: { error }, options: { backend: "plamo", plamoModel }, result: {} });
  expect(error).toHaveBeenCalledWith(`[live2] settings applied; backend=plamo, plamoModel=${plamoModel}`);
});
