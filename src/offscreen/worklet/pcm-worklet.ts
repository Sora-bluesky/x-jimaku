declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;

  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];

    if (
      channels === undefined ||
      channels.length === 0
    ) {
      return true;
    }

    const firstChannel = channels[0];

    if (
      firstChannel === undefined ||
      firstChannel.length === 0
    ) {
      return true;
    }

    const mono = new Float32Array(
      firstChannel.length,
    );

    if (channels.length === 1) {
      mono.set(firstChannel);
    } else {
      for (
        let sampleIndex = 0;
        sampleIndex < mono.length;
        sampleIndex += 1
      ) {
        let sum = 0;

        for (
          let channelIndex = 0;
          channelIndex < channels.length;
          channelIndex += 1
        ) {
          sum +=
            channels[channelIndex]?.[sampleIndex] ??
            0;
        }

        mono[sampleIndex] =
          sum / channels.length;
      }
    }

    this.port.postMessage(mono, [mono.buffer]);

    return true;
  }
}

registerProcessor("pcm-tap", PcmTapProcessor);

export {};
