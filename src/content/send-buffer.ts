export const PCM_SEND_BUFFER_CAPACITY = 16;

export interface BufferedSendItem<T> {
  id: number;
  seq: number;
  payload: T;
}

export interface SendBufferEnqueueResult<T> {
  item: BufferedSendItem<T>;
  dropped: BufferedSendItem<T> | null;
}

interface ActiveFlush {
  ids: number[];
  nextIndex: number;
}

export class OrderedSendBuffer<T> {
  private readonly capacity: number;

  private queue:
    BufferedSendItem<T>[] = [];

  private activeFlush:
    | ActiveFlush
    | null = null;

  private nextId = 1;

  private nextSeq = 0;

  constructor(
    capacity = PCM_SEND_BUFFER_CAPACITY,
  ) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 1
    ) {
      throw new RangeError(
        "Send buffer capacity must be a positive integer",
      );
    }

    this.capacity = capacity;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isFlushing(): boolean {
    return this.activeFlush !== null;
  }

  enqueue(
    payload: T,
  ): SendBufferEnqueueResult<T> {
    const item: BufferedSendItem<T> = {
      id: this.nextId,
      seq: this.nextSeq,
      payload,
    };

    this.nextId += 1;
    this.nextSeq += 1;
    this.queue.push(item);

    const dropped =
      this.queue.length > this.capacity
        ? this.queue.shift() ?? null
        : null;

    return {
      item,
      dropped,
    };
  }

  beginFlush():
    | readonly BufferedSendItem<T>[]
    | null {
    if (
      this.activeFlush !== null ||
      this.queue.length === 0
    ) {
      return null;
    }

    const snapshot = [...this.queue];

    this.activeFlush = {
      ids: snapshot.map(
        (item) => item.id,
      ),
      nextIndex: 0,
    };

    return snapshot;
  }

  markSent(
    item: BufferedSendItem<T>,
  ): boolean {
    if (this.activeFlush === null) {
      return false;
    }

    const expectedId =
      this.activeFlush.ids[
        this.activeFlush.nextIndex
      ];
    const pendingItem = this.queue[0];

    if (
      expectedId !== item.id ||
      pendingItem?.id !== item.id
    ) {
      return false;
    }

    this.queue.shift();
    this.activeFlush.nextIndex += 1;
    return true;
  }

  endFlush(): void {
    this.activeFlush = null;
  }

  clear(): void {
    this.queue = [];
    this.activeFlush = null;
  }
}
