import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTranslationQueue } from "./translation-queue";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createTranslationQueue", () => {
  it(
    "lets the next operation run when the one ahead never settles",
    async () => {
      vi.useFakeTimers();
      const queue = createTranslationQueue({
        deadlineMs: 1000,
      });
      const ran: string[] = [];

      queue.enqueue(() => {
        ran.push("stuck:start");
        return new Promise<void>(() => {});
      });
      queue.enqueue(async () => {
        ran.push("next");
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(ran).toEqual(["stuck:start"]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(ran).toEqual(["stuck:start", "next"]);
      expect(queue.abandonedCount()).toBe(1);
    },
  );

  it(
    "keeps ordering when every operation settles in time",
    async () => {
      vi.useFakeTimers();
      const queue = createTranslationQueue({
        deadlineMs: 1000,
      });
      const ran: string[] = [];

      for (const label of ["a", "b", "c"]) {
        queue.enqueue(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
          ran.push(label);
        });
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(ran).toEqual(["a", "b", "c"]);
      expect(queue.abandonedCount()).toBe(0);
    },
  );

  it(
    "does not count an operation that settles before the deadline",
    async () => {
      vi.useFakeTimers();
      const queue = createTranslationQueue({
        deadlineMs: 1000,
      });

      queue.enqueue(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 999);
        });
      });

      await vi.advanceTimersByTimeAsync(2000);
      expect(queue.abandonedCount()).toBe(0);
    },
  );

  it(
    "reports each abandoned operation once",
    async () => {
      vi.useFakeTimers();
      const onAbandoned = vi.fn();
      const queue = createTranslationQueue({
        deadlineMs: 1000,
        onAbandoned,
      });

      queue.enqueue(() => new Promise<void>(() => {}));
      queue.enqueue(() => new Promise<void>(() => {}));

      await vi.advanceTimersByTimeAsync(3000);
      expect(onAbandoned).toHaveBeenCalledTimes(2);
    },
  );

  it(
    "starts the next operation immediately after a reset",
    async () => {
      vi.useFakeTimers();
      const queue = createTranslationQueue({
        deadlineMs: 1000,
      });
      const ran: string[] = [];

      queue.enqueue(() => {
        ran.push("old-session");
        return new Promise<void>(() => {});
      });
      await vi.advanceTimersByTimeAsync(0);

      queue.reset();
      queue.enqueue(async () => {
        ran.push("new-session");
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(ran).toEqual([
        "old-session",
        "new-session",
      ]);
    },
  );

  it(
    "carries a rejection without stopping the queue",
    async () => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(
        () => undefined,
      );
      const queue = createTranslationQueue({
        deadlineMs: 1000,
      });
      const ran: string[] = [];

      queue.enqueue(async () => {
        throw new Error("translate failed");
      });
      queue.enqueue(async () => {
        ran.push("next");
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(ran).toEqual(["next"]);
      expect(queue.abandonedCount()).toBe(0);
    },
  );
});
