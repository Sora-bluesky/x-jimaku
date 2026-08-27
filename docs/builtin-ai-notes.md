# Built-in AI probe notes (2026-08-27)

Two things turned up while probing Chrome's built-in AI on 2026-08-27. The probe scripts lived in `bench/work/`, which is gitignored, so they were never committed and this file is the only durable record of what was observed. Neither issue affects how the bench works today.

## puppeteer-core's default launch args disable the Prompt API

The default argument list that puppeteer-core passes to Chrome includes `--disable-features=...OptimizationHints...` and `--disable-background-networking`. Between them they shut down Chrome's Optimization Guide path, which is what fetches and manages the on-device model. With that path dead, `LanguageModel` availability never leaves `"unavailable"` no matter how long the probe waits.

This matters for the bench because `bench/run-bench.mjs` launches Chrome through puppeteer-core. Anyone who later tries to check the Prompt API from inside the bench will hit the same wall and read it as "the model isn't available on this machine". For such a probe the two flags have to be removed or overridden at launch; the availability result is meaningless otherwise.

## A failed startup can destroy an existing Chrome profile

On Chrome Canary 154.0.8024.0, deliberately forcing a startup failure against an existing profile directory made Chrome exit with code 21 and left that profile unrecoverable afterwards.

Because of this, the probes were run against dedicated throwaway profile directories created under `%TEMP%` rather than any real or reused profile. Anything that experiments with startup flags should do the same.
