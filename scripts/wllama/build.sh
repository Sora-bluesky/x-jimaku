#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -- "$script_dir/../.." && pwd)"
work_dir="${WLLAMA_WORK:-$repo/.wllama-build/source}"
mkdir -p -- "$work_dir"
work_dir="$(cd -- "$work_dir" && pwd)"
# Native Windows Node needs a native path in its environment. Keep the POSIX
# path separately for Bash; normal MSYS argument conversion applies to Node.
export WLLAMA_WORK="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$work_dir")"
pin() {
  node --input-type=module -e 'const {pins}=await import(process.argv[1]); console.log(pins[process.argv[2]])' \
    "$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$script_dir/pins.mjs")" "$1"
}
commit="$(pin wllamaCommit)"
llama_commit="$(pin llamaCppCommit)"

if [[ ! -e "$work_dir/.git" ]]; then
  git -c core.autocrlf=false -c core.longpaths=true clone --no-checkout \
    "$(pin wllamaRepository)" "$work_dir"
  git -C "$work_dir" -c core.autocrlf=false -c core.longpaths=true checkout --detach "$commit"
fi
git -C "$work_dir" config core.autocrlf false
git -C "$work_dir" config core.longpaths true
[[ "$(git -C "$work_dir" rev-parse HEAD)" == "$commit" ]] || { echo 'Wrong wllama commit' >&2; exit 1; }
git -C "$work_dir" -c core.autocrlf=false -c core.longpaths=true submodule update --init --recursive
[[ "$(git -C "$work_dir/llama.cpp" rev-parse HEAD)" == "$llama_commit" ]] || { echo 'Wrong llama.cpp commit' >&2; exit 1; }

mkdir -p -- "$work_dir/build"
archive="$work_dir/build/emdawn.zip"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 5 --retry-all-errors --output "$archive.download" \
    "https://github.com/google/dawn/releases/download/$(pin dawnTag)/$(pin dawnAsset)"
  node "$script_dir/prepare.mjs" --verify-zip "$archive.download"
  mv -- "$archive.download" "$archive"
fi
node "$script_dir/prepare.mjs" --verify-zip "$archive"
node "$script_dir/prepare.mjs"

export D_UID="${UID:-$(id -u)}"
export D_GID="$(id -g)"
export SKIP_COMPAT=1
export EMSDK_IMAGE_TAG=4.0.20
export WLLAMA_TEST_BACKEND=
(
  cd -- "$work_dir/scripts"
  # Scope this to Docker; Node/npm still need normal MSYS path conversion.
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker compose up --build --abort-on-container-exit --exit-code-from llamacpp-wasm-builder llamacpp-wasm-builder
)
(
  cd -- "$work_dir"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  # npm uses cmd.exe by default on Windows; upstream build:worker is a shell script.
  export npm_config_script_shell=bash
  npm ci
  npm run build:glue
  npm run build:worker
)
node "$script_dir/package.mjs"
