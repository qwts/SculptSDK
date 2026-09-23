// Static file server for the e2e fixtures. No framework, no external
// dependency: the fixtures are plain HTML/CSS/JS on purpose, so the e2e
// suite exercises SculptSDK against a real browser without needing a
// build step or bundler in the loop. Binds to localhost only.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(fileURLToPath(import.meta.url), "..", "public");
const port = Number(process.env.PORT ?? 4173);
const host = "127.0.0.1";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = decoded === "/" ? "/index.html" : decoded;
  const resolved = normalize(join(publicDir, relative));
  // Prevent path traversal outside the fixtures' public directory.
  if (!resolved.startsWith(publicDir)) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  const path = resolvePath(req.url ?? "/");
  if (!path) {
    res.writeHead(400).end("bad request");
    return;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(path);
    const type = CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(port, host, () => {
  console.log(`fixtures server listening on http://${host}:${port}`);
});
