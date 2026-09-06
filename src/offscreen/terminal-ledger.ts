import type {
  OffRecognitionMessage,
  RecognitionPayload,
  TranslationRung,
} from "../shared/messages";

export type TerminalLedgerEntry =
  | {
      kind: "pending";
      text: string;
      at: string;
      since: number;
    }
  | {
      kind: "translated";
      text: string;
      ja: string;
      rung: TranslationRung;
    }
  | {
      kind: "fallback";
      text: string;
      rung: "passthrough";
    };

export class TerminalLedger {
  private readonly entries =
    new Map<number, TerminalLedgerEntry>();
  private readonly atById =
    new Map<number, string>();
  private readonly closedIds =
    new Set<number>();

  constructor(
    private readonly requestId: string,
    private readonly release:
      (message: OffRecognitionMessage) => void,
  ) {
  }

  register(line: RecognitionPayload): void {
    if (
      !line.final ||
      this.entries.has(line.id) ||
      this.closedIds.has(line.id)
    ) {
      return;
    }

    this.entries.set(line.id, {
      kind: "pending",
      text: line.text,
      at: line.at,
      since: performance.now(),
    });
    this.atById.set(line.id, line.at);
  }

  translated(
    id: number,
    ja: string,
    rung: TranslationRung,
  ): void {
    const entry = this.entries.get(id);

    if (entry?.kind !== "pending") {
      return;
    }

    this.entries.set(id, {
      kind: "translated",
      text: entry.text,
      ja,
      rung,
    });
    this.flush();
  }

  fallback(ids: readonly number[]): void {
    for (
      const id of [...new Set(ids)]
        .sort((left, right) => left - right)
    ) {
      const entry = this.entries.get(id);

      if (entry?.kind !== "pending") {
        continue;
      }

      this.entries.set(id, {
        kind: "fallback",
        text: entry.text,
        rung: "passthrough",
      });
    }

    this.flush();
  }

  settlePendingAsFallback(): void {
    this.fallback(
      [...this.entries]
        .filter(([, entry]) =>
          entry.kind === "pending"
        )
        .map(([id]) => id),
    );
  }

  private flush(): void {
    while (this.entries.size > 0) {
      const id = Math.min(
        ...this.entries.keys(),
      );
      const entry = this.entries.get(id);

      if (
        entry === undefined ||
        entry.kind === "pending"
      ) {
        return;
      }

      const at = this.atById.get(id);

      if (at === undefined) {
        return;
      }

      const message: OffRecognitionMessage =
        entry.kind === "translated"
          ? {
              t: "OFF_RECOG",
              requestId: this.requestId,
              id,
              text: entry.text,
              final: true,
              at,
              ja: entry.ja,
              rung: entry.rung,
            }
          : {
              t: "OFF_RECOG",
              requestId: this.requestId,
              id,
              text: entry.text,
              final: true,
              at,
              ja: entry.text,
              fallback: true,
              rung: entry.rung,
            };

      this.entries.delete(id);
      this.atById.delete(id);
      this.closedIds.add(id);
      this.release(message);
    }
  }
}

export function createTerminalLedgerGlue(
  requestId: string,
  postFinalRecognition: (
    requestId: string,
    message: OffRecognitionMessage,
  ) => void,
) {
  const ledger =
    new TerminalLedger(
      requestId,
      (message) => {
        postFinalRecognition(
          requestId,
          message,
        );
      },
    );

  return {
    ledger,
    engineCallbacks: {
      onTranslated(
        line: RecognitionPayload,
        ja: string,
        rung: TranslationRung,
      ): void {
        ledger.translated(
          line.id,
          ja,
          rung,
        );
      },

      onSettled(
        ids: readonly number[],
      ): void {
        ledger.fallback(ids);
      },
    },
  };
}
