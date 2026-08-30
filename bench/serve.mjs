import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8123;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".txt", "text/plain; charset=utf-8"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
]);

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mediaUrl(directory, mediaFile) {
  const relative = path.relative(directory, mediaFile);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Media file must be inside the served directory: ${mediaFile}`);
  }

  return `/${relative
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function casePageHtml(sourceUrl, contextTerms = []) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>x-jimaku accuracy bench</title>
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      background: #111;
    }

    body {
      display: grid;
      place-items: center;
    }

    video {
      width: min(960px, 90vw);
      min-height: 320px;
      background: #000;
    }
  </style>
</head>
<body>
  <article data-testid="tweet">
    <div lang="en">${contextTerms.map((t) => `<span>${t}.</span>`).join("\n")}
      <a href="#">@BenchAuthor</a>
    </div>
    <video id="bench-media" src="${sourceUrl}" playsinline controls muted></video>
  </article>
  <script>
    const media = document.querySelector("#bench-media");
    media.play().catch((error) => {
      document.title = "Playback failed: " + error.message;
    });
  </script>
</body>
</html>`;
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());

  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  let start;
  let end;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }

    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function sendFile(request, response, filePath) {
  let fileStat;

  try {
    fileStat = statSync(filePath);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  if (!fileStat.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
  const rangeHeader = request.headers.range;

  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, fileStat.size);

    if (!range) {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
      });
      response.end();
      return;
    }

    const contentLength = range.end - range.start + 1;

    response.writeHead(206, {
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
      "Content-Type": contentType,
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath, range).pipe(response);
    return;
  }

  response.writeHead(200, {
    "Accept-Ranges": "bytes",
    "Content-Length": fileStat.size,
    "Content-Type": contentType,
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

export async function startBenchServer({
  contextTerms = [],
  directory,
  mediaFile,
  port = DEFAULT_PORT,
} = {}) {
  const servedDirectory = path.resolve(directory ?? ".");
  const resolvedMediaFile = path.resolve(mediaFile ?? "");

  if (!isInsideDirectory(servedDirectory, resolvedMediaFile)) {
    throw new Error(`Media file must be inside ${servedDirectory}`);
  }

  const mediaStat = statSync(resolvedMediaFile);

  if (!mediaStat.isFile()) {
    throw new Error(`Media path is not a file: ${resolvedMediaFile}`);
  }

  const sourceUrl = mediaUrl(servedDirectory, resolvedMediaFile);
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Method not allowed\n");
      return;
    }

    let pathname;

    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", `http://${HOST}:${port}`).pathname,
      );
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad request\n");
      return;
    }

    if (pathname === "/" || pathname === "/case.html") {
      const html = casePageHtml(sourceUrl, contextTerms);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(html),
        "Content-Type": "text/html; charset=utf-8",
      });

      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(html);
      }
      return;
    }

    const candidate = path.resolve(
      servedDirectory,
      pathname.replace(/^[/\\]+/, ""),
    );

    if (!isInsideDirectory(servedDirectory, candidate)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden\n");
      return;
    }

    sendFile(request, response, candidate);
  });

  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, HOST);
  });

  return {
    caseUrl: `http://${HOST}:${port}/case.html`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }),
    host: HOST,
    port,
    server,
  };
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedFile === currentFile) {
  const directory = path.resolve(process.argv[2] ?? ".");
  const mediaArgument = process.argv[3];

  if (!mediaArgument) {
    console.error("Usage: node bench/serve.mjs <directory> <media-file>");
    process.exitCode = 1;
  } else {
    const mediaFile = path.isAbsolute(mediaArgument)
      ? mediaArgument
      : path.resolve(directory, mediaArgument);
    const contextTerms = (process.argv[4] ?? "").split(",").filter(Boolean);
    const runningServer = await startBenchServer({ directory, mediaFile, contextTerms });
    console.log(runningServer.caseUrl);
  }
}
