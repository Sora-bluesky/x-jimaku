import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REFS_DIRECTORY = path.join(BENCH_DIRECTORY, "refs");
const WORK_DIRECTORY = path.join(BENCH_DIRECTORY, "work");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readText(filePath, label) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${label} ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function readJson(filePath) {
  const source = readText(filePath, "result JSON");

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Could not parse result JSON ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function resultCase(result) {
  const caseName = result?.case;

  if (
    typeof caseName !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(caseName)
  ) {
    throw new Error(
      "Result JSON must contain a safe non-empty string in case",
    );
  }

  return caseName;
}

function resultTimestamp(resultFile) {
  const match = path.basename(resultFile).match(
    /-(\d{8}-\d{6})\.json$/u,
  );

  if (!match) {
    throw new Error(
      "Result filename must end with -YYYYMMDD-HHMMSS.json",
    );
  }

  return match[1];
}

function resultJaClauses(result) {
  const jaClauses = result?.recognition?.jaClauses;

  if (
    !Array.isArray(jaClauses)
    || !jaClauses.every((clause) => typeof clause === "string")
  ) {
    throw new Error(
      "Result JSON must contain recognition.jaClauses as a string array",
    );
  }

  if (!jaClauses.some((clause) => clause.trim())) {
    throw new Error(
      "No Japanese subtitles were collected in recognition.jaClauses",
    );
  }

  return jaClauses;
}

function buildJudgePrompt(reference, jaClauses) {
  return [
    "あなたは日本語字幕の訳質採点者です。",
    "",
    "## 入力",
    "",
    "### 正解訳（参照）",
    reference,
    "",
    "### システム出力の日本語字幕（jaClauses、1行1節）",
    jaClauses.join("\n"),
    "",
    "## 採点指示",
    "",
    "次の3分類について、問題の件数を数えてください。",
    "1. 誤訳（mistranslation）: 意味が変わっている箇所",
    "2. 欠落（omission）: 参照にあるが出力にない内容",
    "3. 不自然（unnatural）: 日本語として崩れている箇所",
    "",
    "各分類の簡潔な根拠を列挙してください。",
    "ASR由来の英語側の誤りで意味がずれた場合も「誤訳」に数えてください。",
    "原因分解は採点者の仕事ではありません。",
    "フィラーが訳されていないことは「欠落」に数えないでください。",
    "",
    "最終行には、次の厳密な形式の1行だけを出力してください。",
    "SCORE mistranslation=<int> omission=<int> unnatural=<int>",
  ].join("\n");
}

function prepare(resultArgument) {
  const resultFile = path.resolve(resultArgument);
  const result = readJson(resultFile);
  const caseName = resultCase(result);
  const timestamp = resultTimestamp(resultFile);
  const jaClauses = resultJaClauses(result);
  const referenceFile = path.join(
    REFS_DIRECTORY,
    `${caseName}-ja-ref.txt`,
  );
  const reference = readText(referenceFile, "Japanese reference").trim();

  if (!reference) {
    throw new Error(`Japanese reference is empty: ${referenceFile}`);
  }

  const promptFile = path.join(
    WORK_DIRECTORY,
    `judge-${caseName}-${timestamp}.txt`,
  );
  const prompt = buildJudgePrompt(reference, jaClauses);

  mkdirSync(WORK_DIRECTORY, {
    recursive: true,
  });
  writeFileSync(promptFile, `${prompt}\n`, "utf8");
  console.log(promptFile);
}

function parseScore(output) {
  const lines = output.split(/\r?\n/u);
  let scoreLine = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*SCORE\b/u.test(lines[index])) {
      scoreLine = lines[index].trim();
      break;
    }
  }

  if (!scoreLine) {
    throw new Error("SCORE line was not found in judge output");
  }

  const match = scoreLine.match(
    /^SCORE mistranslation=(\d+) omission=(\d+) unnatural=(\d+)$/u,
  );

  if (!match) {
    throw new Error(
      `Malformed SCORE line; expected all three integer fields: ${scoreLine}`,
    );
  }

  const mistranslation = Number(match[1]);
  const omission = Number(match[2]);
  const unnatural = Number(match[3]);

  if (
    !Number.isSafeInteger(mistranslation)
    || !Number.isSafeInteger(omission)
    || !Number.isSafeInteger(unnatural)
  ) {
    throw new Error("SCORE counts must be safe non-negative integers");
  }

  return {
    mistranslation,
    omission,
    unnatural,
    total: mistranslation + omission + unnatural,
  };
}

function parse(judgeOutputArgument) {
  const judgeOutputFile = path.resolve(judgeOutputArgument);
  const output = readText(judgeOutputFile, "judge output");
  console.log(JSON.stringify(parseScore(output)));
}

function usage() {
  return [
    "Usage:",
    "  node bench/score-ja.mjs prepare <result.json>",
    "  node bench/score-ja.mjs parse <judge-output.txt>",
  ].join("\n");
}

function main(argv) {
  if (argv.length !== 2) {
    throw new Error(usage());
  }

  const [mode, fileArgument] = argv;

  if (mode === "prepare") {
    prepare(fileArgument);
    return;
  }

  if (mode === "parse") {
    parse(fileArgument);
    return;
  }

  throw new Error(`Unknown mode: ${mode}\n${usage()}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[score-ja] ${errorMessage(error)}`);
  process.exitCode = 1;
}
