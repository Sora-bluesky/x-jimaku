import {
  describe,
  expect,
  test,
} from "vitest";
import {
  recommendModel,
} from "./model-recommendation";

interface RecommendationCase {
  name: string;
  info:
    | {
        vendor?: string;
        architecture?: string;
      }
    | undefined;
  device:
    | "webgpu"
    | "wasm"
    | undefined;
  expected:
    | "tiny"
    | "small"
    | null;
}

const cases: RecommendationCase[] = [
  {
    name: "WASMではアダプター情報なしでもtiny",
    info: undefined,
    device: "wasm",
    expected: "tiny",
  },
  {
    name: "WASMではアダプター情報があってもtiny",
    info: {
      vendor: "nvidia",
      architecture: "blackwell",
    },
    device: "wasm",
    expected: "tiny",
  },
  {
    name: "デバイスとアダプター情報が不明ならtiny",
    info: undefined,
    device: undefined,
    expected: "tiny",
  },
  {
    name: "NVIDIA TuringのWebGPUならsmall",
    info: {
      vendor: "nvidia",
      architecture: "turing",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "NVIDIA AmpereのWebGPUならsmall",
    info: {
      vendor: "nvidia",
      architecture: "ampere",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "NVIDIA AdaのWebGPUならsmall",
    info: {
      vendor: "nvidia",
      architecture: "ada",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "NVIDIA LovelaceのWebGPUならsmall",
    info: {
      vendor: "nvidia",
      architecture: "lovelace",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "NVIDIA BlackwellのWebGPUならsmall",
    info: {
      vendor: "nvidia",
      architecture: "blackwell",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "vendorの大文字小文字を区別しない",
    info: {
      vendor: "NvIdIa",
      architecture: "ampere",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "architectureの大文字小文字を区別しない",
    info: {
      vendor: "NVIDIA",
      architecture: "ADA",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "architectureの部分一致を認める",
    info: {
      vendor: "nvidia",
      architecture: "nvidia-lovelace-gpu",
    },
    device: "webgpu",
    expected: "small",
  },
  {
    name: "WebGPUでアダプター情報がなければ推奨なし",
    info: undefined,
    device: "webgpu",
    expected: null,
  },
  {
    name: "WebGPUでvendorがなければ推奨なし",
    info: {
      architecture: "ampere",
    },
    device: "webgpu",
    expected: null,
  },
  {
    name: "WebGPUでarchitectureがなければ推奨なし",
    info: {
      vendor: "nvidia",
    },
    device: "webgpu",
    expected: null,
  },
  {
    name: "WebGPUで空の情報なら推奨なし",
    info: {},
    device: "webgpu",
    expected: null,
  },
  {
    name: "NVIDIAでも対象外architectureなら推奨なし",
    info: {
      vendor: "nvidia",
      architecture: "pascal",
    },
    device: "webgpu",
    expected: null,
  },
  {
    name: "対象architectureでもNVIDIA以外なら推奨なし",
    info: {
      vendor: "amd",
      architecture: "ampere",
    },
    device: "webgpu",
    expected: null,
  },
  {
    name: "デバイス不明で情報だけある場合は推奨なし",
    info: {
      vendor: "nvidia",
      architecture: "blackwell",
    },
    device: undefined,
    expected: null,
  },
  {
    name: "デバイス不明で空の情報がある場合は推奨なし",
    info: {},
    device: undefined,
    expected: null,
  },
];

describe("recommendModel", () => {
  test.each(cases)(
    "$name",
    ({
      info,
      device,
      expected,
    }) => {
      expect(
        recommendModel(info, device),
      ).toBe(expected);
    },
  );
});
