# Requirements and measured behavior

[English](requirements.md) | [日本語](requirements.ja.md)

x-jimaku needs Chrome 138 or later with WebGPU and an available GPU adapter. PLaMo translation has no CPU fallback. Model files need local storage, and the first download needs an internet connection. Whisper is downloaded separately from PLaMo. The sizes below cover only PLaMo.

## Before choosing a model size

These values were measured on a single RTX 4070 12 GB, Windows 11, Chrome Canary 159. Other GPUs are not measured, and other operating systems have not been tested here. The table comes from prototype tests in a real extension offscreen document, using the pfnet Q4_K_M GGUF models and a locally built wllama with WebGPU. It is not a minimum-VRAM specification or a measurement of the full product pipeline.

| Item | 0.8B (default) | 2B | 8B |
| --- | ---: | ---: | ---: |
| PLaMo file size | 573,126,848 bytes | 1,807,203,040 bytes | 5,280,445,728 bytes |
| Layers on WebGPU | 17 / 17 | 25 / 25 | 33 / 33 |
| First load, including download | 63.8 s | 287.8 s | 896.9 s |
| Cached load | 4.4 s | 6.0 s | 12.8 s |
| Translation per line, p50 / p95, 40 lines | 499 / 604 ms | 569 / 639 ms | 779 / 973 ms |
| Peak GPU memory increase, PLaMo alone | +949 MiB | +2,177 MiB | +5,337 MiB |
| Peak GPU memory increase with Whisper base | +1,436 MiB | +2,840 MiB | Not measured |
| Product-path quality and latency | Measured below | Not measured | Not measured |

The file size is the model file, not total storage use. Keep space for Whisper and browser storage as well. GPU-memory increases are observations on this machine, not minimum GPU capacities. There is no estimate for 8B with Whisper.

How the prototype values were measured:

- First load includes fetching from Hugging Face, so connection speed affects it. The table uses the run that completed the line test. Cached load is a separate load with the model already stored.
- The line test repeated the five sentences in `bench/refs/tts2-script.txt` eight times, for 40 lines. It used no translation history or glossary, `max_tokens=128`, and temperature zero. The p95 uses linear interpolation across the 40 samples.
- GPU memory was sampled with `nvidia-smi --query-gpu=memory.used` every 0.5 s. Each value is the maximum during execution minus usage before Chrome started. It covers the whole GPU, not just Chrome. PLaMo-alone peaks cover two model loads.
- Concurrent Whisper base tests were short prototype runs, once per measured size. They do not establish long-session stability. The 8B concurrent case was not run.

Here p50 is the median, and p90 and p95 describe the upper part of the observed latency distribution. Prototype line timings exclude speech recognition and caption display.

## Calculated download times

These are calculations, not measurements. They use the exact file sizes above and a constant effective transfer rate: `seconds = bytes × 8 / (Mbit/s × 1,000,000)`. Values are rounded to one decimal place. They exclude connection overhead, verification, loading, and the separate Whisper download. Actual first load can take longer.

| PLaMo size | At 10 Mbit/s | At 50 Mbit/s | At 100 Mbit/s |
| --- | ---: | ---: | ---: |
| 0.8B | 458.5 s | 91.7 s | 45.9 s |
| 2B | 1,445.8 s | 289.2 s | 144.6 s |
| 8B | 4,224.4 s | 844.9 s | 422.4 s |

## Measured product path

Only 0.8B has end-to-end product measurements. The repository bench was run five times on the same machine with Whisper base and the English source row enabled:

```sh
node bench/live2.mjs --case tts2 --model base --plamo-model 0.8b --show-original
```

The following counts are totals across the five runs. The comparison is the v0.7.0 Prompt API baseline across its five runs.

| Counter | PLaMo 0.8B | v0.7.0 Prompt API baseline |
| --- | ---: | ---: |
| `englishPassthrough`: output lines without Japanese | 0 | 1 |
| `wrongSenseRoma`: ローマ without the following ン | 0 | 0 |
| `unresolvedPlaceholders`: unresolved `%%` markers | 0 | 0 |
| `romanKept`: the English word Roman left in output | 0 | 1 |

These counters check specific failure patterns in this fixture. They are not a general translation-quality score.

Latency from the end of a matched script sentence in the audio to the appearance of a Japanese caption page was p50 2.58 s and p90 4.50 s across 88 matched pages pooled from the runs, and 28 pages could not be matched. Per-run p50 ranged from 2.0 to 4.2 s. Translation per line on the product path had per-run p50 of 0.60–0.78 s (per-run p50 of 604–783 ms). This includes product translation context and differs from the prototype line test above.

The same runs also measured how quickly captions had to be read:

| Japanese characters per second | Share of caption pages above that rate | Share of shown time above that rate |
| --- | ---: | ---: |
| 7 | 60% | 42% |
| 4 | 72% | 58% |

The shares are rounded. They describe displayed text and time, not a reading-speed target or a user study. Captions can be too fast to read even when translation finishes quickly.

## Choosing and checking

0.8B is the default and the only size measured end to end. Use that evidence as the starting point on the measured machine. The prototype table does not establish that 2B or 8B improves product quality. Their product-path quality and latency are unmeasured. We make no model-size recommendation for other GPUs.

## Check your machine

Stop captioning, open the extension's options page, select a PLaMo size and style, and click 「この PC で試す」. The self-check shows:

- Whether WebGPU and an adapter are available, and the adapter information exposed by Chrome.
- `maxBufferSize` and `maxStorageBufferBindingSize`.
- Model load time, including download and verification when needed.
- The translation and time per line for three short English sentences.

If WebGPU or an adapter is unavailable, it stops before downloading. The check may download the selected model if it is not saved. It runs separately from live captioning, so it does not measure Whisper concurrency or end-to-end caption latency. Adapter limits are reference information, and the check does not decide whether a model will fit.
