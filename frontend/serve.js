// Zero-dependency static file server — no npm install needed, uses only Node's
// built-in modules. Exists specifically because wallet extensions (MetaMask etc.)
// break on file:// pages: the origin is `null` there, and the extension's internal
// postMessage handshake between its content script and injected page script requires
// a real origin to route correctly. Serving over http://localhost fixes this.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  let filePath = req.url === "/" ? "/create-token.html" : req.url;
  filePath = path.join(ROOT, decodeURIComponent(filePath.split("?")[0]));

  // Basic guard against escaping the served folder via ../
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + req.url);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Serving this folder at: http://localhost:${PORT}`);
  console.log(`Open that URL in your browser — not the file directly.`);
  console.log(`Press Ctrl+C to stop.`);
});
