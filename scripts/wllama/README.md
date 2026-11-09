# Bundled wllama

The published wllama 3.8.1 cannot load the PLaMo 3 tokenizer. This build
bundles wllama until a published npm release can load PLaMo 3 Translate.
Replace this build with that npm release once it passes the same model test.

Pins (also enforced by `pins.mjs`):

- wllama: `c10c21114984e37fe6ba4edbba446c28c5b7a954`
- llama.cpp: `d38bea34227bbf9069d62fdc239c98ab6e05435a`
- Emscripten: `emscripten/emsdk:4.0.20@sha256:460fff8f8ac87e11b16447fbd66538a686eafa0e4fb977aa0989ed19fe2079f7`
- Dawn: `v20260317.182325`, `emdawnwebgpu_pkg-v20260317.182325.zip`
- Dawn zip SHA-256: `8dcae86c630d76b6794b271c6572becba36f4237d132bee121a56638c3d76575`

On a host with Git, Bash, curl, Node/npm and Docker Compose, run from the repo:

```bash
bash scripts/wllama/build.sh
# Optional: use another dedicated build checkout (including a Git Bash path).
WLLAMA_WORK=/path/to/wllama bash scripts/wllama/build.sh
npm run typecheck
npm test
npm run build
```

Docker must run Linux containers. Git Bash on Windows is supported; the script
disables MSYS argument conversion for Docker and uses Bash for npm lifecycle
scripts. The default checkout and staging directories are under the ignored
`.wllama-build/`. Re-runs reuse the checkout and verified download. A different
commit, a mismatched zip or an unexpected compose source fails rather than
silently switching versions. Use a fresh dedicated directory to recover a
checkout made with CRLF conversion; do not use a working development checkout.

The host verifies the Dawn download before the upstream compose build. The
compose edits pin the image, allow Git to inspect the container's mounted source,
and reuse the valid host-provided zip. Only the non-compat JSPI/WebGPU build runs.
`npm ci`, glue generation, worker generation and tsup run on the host.

`package.mjs` can also package an already built checkout without Docker:

```bash
WLLAMA_WORK=/path/to/built/wllama node scripts/wllama/package.mjs --dry-run
WLLAMA_WORK=/path/to/built/wllama node scripts/wllama/package.mjs
```

The dry run writes nothing. It checks the generated strings (including decoded
CR characters), source adaptations, commits, zip and licenses; it does not run
tsup or validate the final bundle. A real package run bundles `src/index.ts`
as ESM with declarations into a staging directory, verifies it, then copies it
to `vendor/wllama/`. No source maps or build dates are included. `SOURCE.json`
records every other file's SHA-256 and byte size. `verify.mjs`, the vendor test
and Vite verify those identities, the inventory, pins and CSP constraints.

The two upstream Blob worker factories become static module workers. The llama
worker contains the upstream JSPI stub, Emscripten module wrapper and generated
worker body. Its wasm URL and both worker URLs resolve from `self.location.origin`
under `/wllama/`, including from nested workers. It fixes `nbThread` to 0 and
`compat` to false. Pthread allocation throws explicitly; dynamic script Blobs
and their unused helper are removed. Blobs for model/cache data remain supported.
The extension's CSP stays `script-src 'self' 'wasm-unsafe-eval'`.

Licenses come from the checkout and the hash-verified Dawn zip. PLaMo models are
downloaded at run time from `huggingface.co/pfnet` under the PLaMo Community
License; model weights are not bundled here.
