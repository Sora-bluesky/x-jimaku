import {
  describe,
  expect,
  it,
} from "vitest";
import {
  OrderedSendBuffer,
  PCM_SEND_BUFFER_CAPACITY,
  type BufferedSendItem,
} from "./send-buffer";

type BufferedContentPayload =
  | {
      t: "CS_PCM";
      requestId: string;
      seq: number;
      b64: string;
    }
  | {
      t: "CS_EOS";
      requestId: string;
    }
  | {
      t: "CS_TRANSLATE_RESULT";
      requestId: string;
      id: number;
      ja: string;
      available: boolean;
    };

describe("OrderedSendBuffer", () => {
  it("keeps sixteen entries and drops the oldest", () => {
    const buffer =
      new OrderedSendBuffer<number>();

    let dropped:
      | BufferedSendItem<number>
      | null = null;

    for (
      let value = 0;
      value <= PCM_SEND_BUFFER_CAPACITY;
      value += 1
    ) {
      dropped =
        buffer.enqueue(value).dropped;
    }

    expect(dropped?.payload).toBe(0);
    expect(buffer.pendingCount).toBe(
      PCM_SEND_BUFFER_CAPACITY,
    );

    const batch = buffer.beginFlush();

    expect(
      batch?.map(
        (item) => item.payload,
      ),
    ).toEqual(
      Array.from(
        {
          length:
            PCM_SEND_BUFFER_CAPACITY,
        },
        (_, index) => index + 1,
      ),
    );

    buffer.endFlush();
  });

  it("preserves mixed payload order through flush", () => {
    const buffer =
      new OrderedSendBuffer<
        BufferedContentPayload
      >();
    const payloads:
      BufferedContentPayload[] = [
        {
          t: "CS_PCM",
          requestId: "request-1",
          seq: 1,
          b64: "pcm-1",
        },
        {
          t: "CS_EOS",
          requestId: "request-1",
        },
        {
          t: "CS_TRANSLATE_RESULT",
          requestId: "request-1",
          id: 7,
          ja: "翻訳",
          available: true,
        },
        {
          t: "CS_PCM",
          requestId: "request-1",
          seq: 2,
          b64: "pcm-2",
        },
      ];

    for (const payload of payloads) {
      buffer.enqueue(payload);
    }

    const batch = buffer.beginFlush();

    expect(
      batch?.map(
        (item) => item.payload,
      ),
    ).toEqual(payloads);

    for (const item of batch ?? []) {
      expect(
        buffer.markSent(item),
      ).toBe(true);
    }

    buffer.endFlush();

    expect(buffer.pendingCount).toBe(0);
  });

  it("drops the oldest payload when a mixed queue overflows", () => {
    const buffer =
      new OrderedSendBuffer<
        BufferedContentPayload
      >();
    const oldest:
      BufferedContentPayload = {
        t: "CS_PCM",
        requestId: "request-1",
        seq: 0,
        b64: "oldest",
      };

    buffer.enqueue(oldest);

    for (
      let seq = 1;
      seq < PCM_SEND_BUFFER_CAPACITY;
      seq += 1
    ) {
      buffer.enqueue({
        t: "CS_PCM",
        requestId: "request-1",
        seq,
        b64: `pcm-${seq}`,
      });
    }

    const result = buffer.enqueue({
      t: "CS_TRANSLATE_RESULT",
      requestId: "request-1",
      id: 9,
      ja: "翻訳",
      available: true,
    });

    expect(result.dropped?.payload).toEqual(
      oldest,
    );
    expect(buffer.pendingCount).toBe(
      PCM_SEND_BUFFER_CAPACITY,
    );

    const batch = buffer.beginFlush();

    expect(batch?.[0]?.payload).toEqual({
      t: "CS_PCM",
      requestId: "request-1",
      seq: 1,
      b64: "pcm-1",
    });
    expect(batch?.at(-1)?.payload).toEqual({
      t: "CS_TRANSLATE_RESULT",
      requestId: "request-1",
      id: 9,
      ja: "翻訳",
      available: true,
    });

    buffer.endFlush();
  });

  it("keeps concurrent enqueues behind the snapshot", () => {
    const buffer =
      new OrderedSendBuffer<string>();

    buffer.enqueue("first");
    buffer.enqueue("second");

    const firstBatch =
      buffer.beginFlush();

    expect(
      firstBatch?.map(
        (item) => item.payload,
      ),
    ).toEqual([
      "first",
      "second",
    ]);
    expect(buffer.beginFlush()).toBeNull();

    buffer.enqueue("third");

    for (const item of firstBatch ?? []) {
      expect(
        buffer.markSent(item),
      ).toBe(true);
    }

    buffer.endFlush();

    const secondBatch =
      buffer.beginFlush();

    expect(
      secondBatch?.map(
        (item) => item.payload,
      ),
    ).toEqual(["third"]);

    buffer.endFlush();
  });

  it("retains the unsent suffix after failure", () => {
    const buffer =
      new OrderedSendBuffer<string>();

    buffer.enqueue("first");
    buffer.enqueue("second");
    buffer.enqueue("third");

    const batch = buffer.beginFlush();

    expect(batch).not.toBeNull();
    expect(
      buffer.markSent(batch?.[0] as
        BufferedSendItem<string>),
    ).toBe(true);

    buffer.endFlush();

    const retry = buffer.beginFlush();

    expect(
      retry?.map(
        (item) => item.payload,
      ),
    ).toEqual([
      "second",
      "third",
    ]);

    buffer.endFlush();
  });

  it("does not deliver an acknowledged item twice", () => {
    const buffer =
      new OrderedSendBuffer<string>();
    const delivered: string[] = [];

    buffer.enqueue("first");
    buffer.enqueue("second");
    buffer.enqueue("third");

    const firstAttempt =
      buffer.beginFlush();

    if (firstAttempt === null) {
      throw new Error(
        "Expected a flush snapshot",
      );
    }

    delivered.push(
      firstAttempt[0].payload,
    );
    expect(
      buffer.markSent(
        firstAttempt[0],
      ),
    ).toBe(true);
    buffer.endFlush();

    const retry = buffer.beginFlush();

    if (retry === null) {
      throw new Error(
        "Expected a retry snapshot",
      );
    }

    for (const item of retry) {
      delivered.push(item.payload);
      expect(
        buffer.markSent(item),
      ).toBe(true);
    }

    buffer.endFlush();

    expect(delivered).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.beginFlush()).toBeNull();
  });

  it("rejects out-of-order acknowledgements", () => {
    const buffer =
      new OrderedSendBuffer<string>();

    buffer.enqueue("first");
    buffer.enqueue("second");

    const batch = buffer.beginFlush();

    if (batch === null) {
      throw new Error(
        "Expected a flush snapshot",
      );
    }

    expect(
      buffer.markSent(batch[1]),
    ).toBe(false);
    expect(buffer.pendingCount).toBe(2);
    expect(
      buffer.markSent(batch[0]),
    ).toBe(true);
    expect(buffer.pendingCount).toBe(1);

    buffer.endFlush();
  });
});
