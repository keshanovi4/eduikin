const http = require("node:http");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const { handler: submitLead } = require("./netlify/functions/lead");

const assetsDirectory = path.join(__dirname, "assets");
const bodyLimit = 32 * 1024;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size <= bodyLimit) chunks.push(chunk);
      else reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      let pathname;
      try {
        pathname = decodeURIComponent(request.url.split("?")[0]);
      } catch {
        response.writeHead(400).end("Invalid URL");
        return;
      }

      // Keep the existing form URL working on both Railway and Netlify.
      if (pathname === "/.netlify/functions/lead" || pathname === "/api/lead") {
        const body = request.method === "POST" ? await readBody(request) : "";
        const result = await submitLead({ httpMethod: request.method, body });
        response.writeHead(result.statusCode, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          ...result.headers,
        }).end(result.body);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed");
        return;
      }

      if (pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
        return;
      }

      let filename;
      if (pathname === "/" || pathname === "/index.html") {
        filename = path.join(__dirname, "index.html");
      } else if (pathname.startsWith("/assets/")) {
        filename = path.resolve(assetsDirectory, pathname.slice("/assets/".length));
        if (!filename.startsWith(assetsDirectory + path.sep)) {
          response.writeHead(404).end("Not Found");
          return;
        }
      } else {
        response.writeHead(404).end("Not Found");
        return;
      }

      const file = await readFile(filename);
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filename).toLowerCase()] || "application/octet-stream",
        "Content-Length": file.length,
        "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=3600" : "no-cache",
      }).end(request.method === "HEAD" ? undefined : file);
    } catch (error) {
      const statusCode = error.statusCode || (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code) ? 404 : 500);
      response.writeHead(statusCode).end(statusCode === 413 ? "Request body too large" : statusCode === 404 ? "Not Found" : "Internal Server Error");
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`DEIKIN listening on port ${port}`);
  });
}

module.exports = { createServer };
