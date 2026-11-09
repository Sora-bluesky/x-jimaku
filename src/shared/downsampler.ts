export const PCM_TARGET_SAMPLE_RATE =
  16_000;

export class StreamingLinearDownsampler {
  private readonly sourceStep: number;
  private bufferedSamples: Float32Array =
    new Float32Array(0);
  private nextSourcePosition = 0;

  constructor(
    sourceSampleRate: number,
    targetSampleRate: number =
      PCM_TARGET_SAMPLE_RATE,
  ) {
    validateSampleRates(
      sourceSampleRate,
      targetSampleRate,
    );

    this.sourceStep =
      sourceSampleRate / targetSampleRate;
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) {
      return new Float32Array(0);
    }

    this.bufferedSamples = concatenateSamples(
      this.bufferedSamples,
      input,
    );

    const finalInterpolatablePosition =
      this.bufferedSamples.length - 1;

    if (
      this.nextSourcePosition >=
      finalInterpolatablePosition
    ) {
      return new Float32Array(0);
    }

    const outputLength = Math.ceil(
      (
        finalInterpolatablePosition -
        this.nextSourcePosition
      ) / this.sourceStep,
    );
    const output =
      new Float32Array(outputLength);

    let sourcePosition =
      this.nextSourcePosition;

    for (
      let outputIndex = 0;
      outputIndex < outputLength;
      outputIndex += 1
    ) {
      const leftIndex =
        Math.floor(sourcePosition);
      const rightIndex = leftIndex + 1;
      const fraction =
        sourcePosition - leftIndex;
      const left =
        this.bufferedSamples[leftIndex] ?? 0;
      const right =
        this.bufferedSamples[rightIndex] ??
        left;

      output[outputIndex] =
        left + (right - left) * fraction;
      sourcePosition += this.sourceStep;
    }

    const dropCount = Math.min(
      Math.floor(sourcePosition),
      this.bufferedSamples.length - 1,
    );

    this.bufferedSamples =
      this.bufferedSamples.slice(dropCount);
    this.nextSourcePosition =
      sourcePosition - dropCount;

    return output;
  }

  reset(): void {
    this.bufferedSamples =
      new Float32Array(0);
    this.nextSourcePosition = 0;
  }
}

export function downsampleLinear(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number =
    PCM_TARGET_SAMPLE_RATE,
): Float32Array {
  validateSampleRates(
    sourceSampleRate,
    targetSampleRate,
  );

  if (input.length === 0) {
    return new Float32Array(0);
  }

  if (sourceSampleRate === targetSampleRate) {
    return input.slice();
  }

  const outputLength = Math.max(
    1,
    Math.round(
      input.length *
      targetSampleRate /
      sourceSampleRate,
    ),
  );
  const output =
    new Float32Array(outputLength);
  const sourceStep =
    sourceSampleRate / targetSampleRate;

  for (
    let outputIndex = 0;
    outputIndex < outputLength;
    outputIndex += 1
  ) {
    const sourcePosition =
      outputIndex * sourceStep;
    const leftIndex = Math.min(
      Math.floor(sourcePosition),
      input.length - 1,
    );
    const rightIndex = Math.min(
      leftIndex + 1,
      input.length - 1,
    );
    const fraction =
      sourcePosition - leftIndex;
    const left = input[leftIndex] ?? 0;
    const right =
      input[rightIndex] ?? left;

    output[outputIndex] =
      left + (right - left) * fraction;
  }

  return output;
}

function validateSampleRates(
  sourceSampleRate: number,
  targetSampleRate: number,
): void {
  if (
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    !Number.isFinite(targetSampleRate) ||
    targetSampleRate <= 0
  ) {
    throw new RangeError(
      "Sample rates must be finite positive numbers",
    );
  }
}

function concatenateSamples(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  if (left.length === 0) {
    return right.slice();
  }

  const combined = new Float32Array(
    left.length + right.length,
  );

  combined.set(left);
  combined.set(right, left.length);

  return combined;
}
