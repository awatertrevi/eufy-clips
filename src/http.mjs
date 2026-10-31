// Small HTTP API plus the static UI that Home Assistant shows in an iframe.
// Every request needs ?token=… (or the cookie set from it), because the clips show people at home.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

const PUBLIC = path.join(import.meta.dirname, "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export function startHttp({ client, store, cache, sync, config, log }) {
  const authorized = (req, url) => {
    const supplied = url.searchParams.get("token") ?? /(?:^|;\s*)eufy_clips=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const a = Buffer.from(supplied);
    const b = Buffer.from(config.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    // ?station=SN[,SN] limits the UI to those HomeBases (one service can serve several houses).
    const stations = url.searchParams.get("station")?.split(",").filter(Boolean) || undefined;
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true, eufy: client.state });
      if (!authorized(req, url)) return send(res, 401, { error: "token required" });
      if (url.searchParams.has("token")) {
        res.setHeader("set-cookie", `eufy_clips=${config.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      }

      if (url.pathname === "/api/status") {
        return send(res, 200, { eufy: client.state, captcha: client.state === "needs-captcha" ? client.captcha?.image : undefined, sync: sync.last, events: store.countsByDevice(stations) });
      }
      if (url.pathname === "/api/2fa" && req.method === "POST") {
        const { code } = await body(req);
        await client.submitCode(String(code).trim());
        return send(res, 202, { ok: true });
      }
      if (url.pathname === "/api/captcha" && req.method === "POST") {
        const { answer } = await body(req);
        await client.submitCaptcha(String(answer).trim());
        return send(res, 202, { ok: true });
      }
      if (url.pathname === "/api/sync" && req.method === "POST") {
        sync.run().catch(error => log.warn(`sync: ${error.message}`));
        return send(res, 202, { ok: true });
      }
      if (url.pathname === "/api/cameras") return send(res, 200, (await client.cameras()).filter(c => !stations || stations.includes(c.station)));
      if (url.pathname === "/api/events") {
        const events = store.list({
          stations,
          device: url.searchParams.get("device") || undefined,
          before: url.searchParams.get("before") || undefined,
          limit: Math.min(Number(url.searchParams.get("limit")) || 60, 500),
        });
        return send(res, 200, events.map(e => ({ ...e, cached: cache.has(e) })));
      }

      const media = /^\/api\/events\/(\d+)\/(clip\.mp4|thumb\.jpg)$/.exec(url.pathname);
      if (media) {
        const event = store.get(Number(media[1]));
        if (!event) return send(res, 404, { error: "unknown event" });
        const file = media[2] === "clip.mp4" ? await cache.clip(event) : await cache.thumbnail(event);
        return sendFile(req, res, file, media[2] === "clip.mp4" ? "video/mp4" : "image/jpeg", "private, max-age=86400");
      }

      const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return sendFile(req, res, file, TYPES[path.extname(file)] ?? "application/octet-stream", "no-cache");
      }
      send(res, 404, { error: "not found" });
    } catch (error) {
      log.warn(`http ${url.pathname}: ${error.message}`);
      if (!res.headersSent) send(res, 502, { error: error.message });
    }
  });
  server.listen(config.port, config.host, () => log.info(`http: listening on ${config.host}:${config.port}`));
  return server;
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

/** Serve a file with Range support so the browser's video element can seek. */
function sendFile(req, res, file, type, cacheControl) {
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": cacheControl };
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "content-length": size });
  fs.createReadStream(file).pipe(res);
}

async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10_000) throw new Error("body too large");
  }
  return JSON.parse(text || "{}");
}
