import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  TerminalLedger,
} from "./terminal-ledger";

function register(
  ledger: TerminalLedger,
  id: number,
): void {
  ledger.register({
    id,
    text: `source-${id}`,
    final: true,
    at: `2026-09-02T00:00:0${id}.000Z`,
  });
}

describe("TerminalLedger", () => {
  it("A-6-4(b'') holds dropped and translated followers behind the pending head", () => {
    const release = vi.fn();
    const ledger =
      new TerminalLedger("request-1", release);

    register(ledger, 1);
    register(ledger, 2);
    ledger.translated(2, "二");

    expect(release).not.toHaveBeenCalled();

    ledger.translated(1, "一");

    expect(
      release.mock.calls.map(
        ([message]) => message,
      ),
    ).toEqual([
      expect.objectContaining({
        id: 1,
        ja: "一",
      }),
      expect.objectContaining({
        id: 2,
        ja: "二",
      }),
    ]);

    register(ledger, 3);
    register(ledger, 4);
    ledger.fallback([4]);

    expect(release).toHaveBeenCalledTimes(2);

    ledger.translated(3, "三");

    expect(
      release.mock.calls.slice(2).map(
        ([message]) => message,
      ),
    ).toEqual([
      expect.objectContaining({
        id: 3,
        ja: "三",
      }),
      expect.objectContaining({
        id: 4,
        ja: "source-4",
        fallback: true,
      }),
    ]);
  });

  it("A-6-4(b'''''') keeps the first terminal in both directions", () => {
    const release = vi.fn();
    const ledger =
      new TerminalLedger("request-2", release);

    register(ledger, 5);
    ledger.fallback([5]);
    ledger.translated(5, "late");

    register(ledger, 6);
    ledger.translated(6, "六");
    ledger.fallback([6]);

    expect(
      release.mock.calls.map(
        ([message]) => message,
      ),
    ).toEqual([
      expect.objectContaining({
        id: 5,
        ja: "source-5",
        fallback: true,
      }),
      expect.objectContaining({
        id: 6,
        ja: "六",
      }),
    ]);
  });
});
