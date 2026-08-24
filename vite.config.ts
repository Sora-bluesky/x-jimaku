import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineConfig,
  type Plugin,
} from "vite";

const projectRoot = fileURLToPath(
  new URL(".", import.meta.url),
);

export default defineConfig({
  base: "/",
  publicDir: false,
  build: {
    target: "esnext",
    outDir: resolve(projectRoot, "dist"),
    emptyOutDir: !process.argv.includes("--watch"),
    rollupOptions: {
      input: {
        background: resolve(
          projectRoot,
          "src/background/index.ts",
        ),
        offscreen: resolve(
          projectRoot,
          "src/offscreen/offscreen.html",
        ),
        options: resolve(
          projectRoot,
          "src/options/options.html",
        ),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  worker: {
    format: "es",
  },
  plugins: [
    finalizeDist(),
  ],
});

function finalizeDist(): Plugin {
  const outDir = resolve(projectRoot, "dist");

  const htmlOutputs = [
    {
      fileName: "offscreen.html",
      expectedPath: resolve(
        outDir,
        "src/offscreen/offscreen.html",
      ),
    },
    {
      fileName: "options.html",
      expectedPath: resolve(
        outDir,
        "src/options/options.html",
      ),
    },
  ] as const;

  return {
    name: "x-jimaku-finalize-dist",
    enforce: "post",

    async closeBundle(): Promise<void> {
      const htmlPlans = await Promise.all(
        htmlOutputs.map(async (output) => ({
          ...output,
          sourcePath: await findEmittedHtml(
            outDir,
            output.fileName,
            output.expectedPath,
          ),
          targetPath: resolve(outDir, output.fileName),
        })),
      );

      for (const plan of htmlPlans) {
        const html = await readFile(
          plan.sourcePath,
          "utf8",
        );
        const rewrittenHtml =
          rewriteRelativeAssetReferences(html);

        if (rewrittenHtml !== html) {
          await writeFile(
            plan.sourcePath,
            rewrittenHtml,
            "utf8",
          );
        }

        if (plan.sourcePath !== plan.targetPath) {
          if (await pathExists(plan.targetPath)) {
            await rm(plan.targetPath);
          }

          await rename(
            plan.sourcePath,
            plan.targetPath,
          );
        }
      }

      await rm(resolve(outDir, "src"), {
        recursive: true,
        force: true,
      });

      await mkdir(outDir, {
        recursive: true,
      });
      await copyFile(
        resolve(projectRoot, "public/manifest.json"),
        resolve(outDir, "manifest.json"),
      );

      await copyOnnxRuntimeAssets(outDir);
    },
  };
}

async function findEmittedHtml(
  outDir: string,
  fileName: string,
  expectedPath: string,
): Promise<string> {
  if (await isFile(expectedPath)) {
    return expectedPath;
  }

  const candidates = await findFilesNamed(
    outDir,
    fileName,
  );

  if (candidates.length === 0) {
    throw new Error(
      `Could not find generated HTML for ${fileName} in ${outDir}`,
    );
  }

  if (candidates.length > 1) {
    const candidateList = candidates
      .map((candidate) =>
        formatDistPath(outDir, candidate),
      )
      .join(", ");

    throw new Error(
      `Found multiple generated HTML files for ${fileName}: ${candidateList}`,
    );
  }

  return candidates[0];
}

async function findFilesNamed(
  directory: string,
  fileName: string,
): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  entries.sort((left, right) => {
    if (left.name < right.name) {
      return -1;
    }

    if (left.name > right.name) {
      return 1;
    }

    return 0;
  });

  const matches: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(
      directory,
      entry.name,
    );

    if (entry.isDirectory()) {
      matches.push(
        ...await findFilesNamed(
          entryPath,
          fileName,
        ),
      );
    } else if (
      entry.isFile() &&
      entry.name === fileName
    ) {
      matches.push(entryPath);
    }
  }

  return matches;
}

async function copyOnnxRuntimeAssets(
  outDir: string,
): Promise<void> {
  const sourceDir = resolve(
    projectRoot,
    "node_modules/onnxruntime-web/dist",
  );
  const targetDir = resolve(outDir, "ort");
  const entries = await readdir(sourceDir, {
    withFileTypes: true,
  });

  const assetNames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (
          entry.name.endsWith(".wasm") ||
          entry.name.endsWith(".mjs")
        ),
    )
    .map((entry) => entry.name)
    .sort();

  const hasWasm = assetNames.some((name) =>
    name.endsWith(".wasm"),
  );
  const hasMjs = assetNames.some((name) =>
    name.endsWith(".mjs"),
  );

  if (!hasWasm || !hasMjs) {
    const missingPatterns = [
      !hasWasm ? "*.wasm" : undefined,
      !hasMjs ? "*.mjs" : undefined,
    ]
      .filter(
        (pattern): pattern is string =>
          pattern !== undefined,
      )
      .join(" and ");

    throw new Error(
      `Could not find ${missingPatterns} in ${sourceDir}`,
    );
  }

  await mkdir(targetDir, {
    recursive: true,
  });

  for (const assetName of assetNames) {
    await copyFile(
      resolve(sourceDir, assetName),
      resolve(targetDir, assetName),
    );
  }
}

function rewriteRelativeAssetReferences(
  html: string,
): string {
  const quotedUrlAttributes =
    /(\b(?:src|href|poster|data|action|formaction)\s*=\s*)(["'])(\.\.?\/[^"']*)\2/giu;
  const unquotedUrlAttributes =
    /(\b(?:src|href|poster|data|action|formaction)\s*=\s*)(\.\.?\/[^\s"'=<>`]+)/giu;
  const sourceSetAttributes =
    /(\b(?:srcset|imagesrcset)\s*=\s*)(["'])([^"']*)\2/giu;
  const styleUrls =
    /(url\(\s*)(["']?)(\.\.?\/[^"'()]+?)\2(\s*\))/giu;

  return html
    .replace(
      quotedUrlAttributes,
      (
        _match: string,
        prefix: string,
        quote: string,
        reference: string,
      ) =>
        `${prefix}${quote}` +
        `${toRootRelativeUrl(reference)}${quote}`,
    )
    .replace(
      unquotedUrlAttributes,
      (
        _match: string,
        prefix: string,
        reference: string,
      ) =>
        `${prefix}${toRootRelativeUrl(reference)}`,
    )
    .replace(
      sourceSetAttributes,
      (
        _match: string,
        prefix: string,
        quote: string,
        value: string,
      ) =>
        `${prefix}${quote}` +
        `${rewriteSourceSet(value)}${quote}`,
    )
    .replace(
      styleUrls,
      (
        _match: string,
        prefix: string,
        quote: string,
        reference: string,
        suffix: string,
      ) =>
        `${prefix}${quote}` +
        `${toRootRelativeUrl(reference)}` +
        `${quote}${suffix}`,
    );
}

function rewriteSourceSet(
  sourceSet: string,
): string {
  return sourceSet.replace(
    /(^|,\s*)(\.\.?\/[^\s,]+)(?=\s|,|$)/gu,
    (
      _match: string,
      prefix: string,
      reference: string,
    ) =>
      `${prefix}${toRootRelativeUrl(reference)}`,
  );
}

function toRootRelativeUrl(
  reference: string,
): string {
  const suffixIndex = reference.search(/[?#]/u);
  const pathname =
    suffixIndex === -1
      ? reference
      : reference.slice(0, suffixIndex);
  const suffix =
    suffixIndex === -1
      ? ""
      : reference.slice(suffixIndex);

  let rootRelativePath = posix.resolve(
    "/",
    pathname,
  );

  if (
    pathname.endsWith("/") &&
    !rootRelativePath.endsWith("/")
  ) {
    rootRelativePath += "/";
  }

  return `${rootRelativePath}${suffix}`;
}

async function isFile(
  path: string,
): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

async function pathExists(
  path: string,
): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingPathError(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function formatDistPath(
  outDir: string,
  path: string,
): string {
  return relative(outDir, path).replaceAll(
    "\\",
    "/",
  );
}
