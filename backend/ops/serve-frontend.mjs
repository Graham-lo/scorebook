// Shared-owner web entry; LAN access is opt-in. Credentials stay in this process.
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pipeline } from 'node:stream';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/** RFC 1918 private ranges plus 100.64.0.0/10 (CGNAT, used by Tailscale for the user's own devices). */
function privateIPv4(address) {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
}

export async function createFrontendServer({ dist, tokenFile, api, port, lan = false, interfaces = networkInterfaces }) {
  const root = await realpath(dist);
  const upstream = new URL(api);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('API must be a loopback HTTP origin');
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('Invalid credential file');
  const origin = `http://127.0.0.1:${port}`;
  const reject = (res, status) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(http.STATUS_CODES[status]);
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (lan) {
      for (const addresses of Object.values(interfaces())) {
        for (const entry of addresses ?? []) {
          if (entry.family === 'IPv4' && !entry.internal && privateIPv4(entry.address)) allowedHosts.add(`${entry.address}:${port}`);
        }
      }
      const peer = req.socket.remoteAddress;
      if (peer !== '127.0.0.1' && !privateIPv4(peer ?? '')) return reject(res, 403);
    }
    // A top-level GET navigation from another site (a link in a chat app, a bookmark page, the OS "open") is how people
    // arrive; only cross-site sub-resource / API requests are rejected, which is what the CSRF check is for.
    const crossSiteNavigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (!allowedHosts.has(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || (req.headers['sec-fetch-site'] === 'cross-site' && !crossSiteNavigation)) return reject(res, 403);
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return reject(res, 400);
    let url;
    try { url = new URL(req.url, origin); } catch { return reject(res, 400); }
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...req.headers, host: upstream.host, authorization: `Bearer ${token}`, origin };
      for (const name of ['cookie', 'connection', 'proxy-authorization', 'proxy-connection', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto']) delete headers[name];
      const proxy = http.request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: url.pathname.slice(4) + url.search, headers }, response => {
        const responseHeaders = { ...response.headers, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
        for (const name of ['set-cookie', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'access-control-allow-origin']) delete responseHeaders[name];
        res.writeHead(response.statusCode ?? 502, responseHeaders);
        pipeline(response, res, () => {}); // Streams binary bodies and SSE without buffering.
      });
      proxy.on('error', () => { if (!res.headersSent) reject(res, 502); else res.destroy(); });
      req.on('aborted', () => proxy.destroy());
      res.on('close', () => { if (!res.writableFinished) proxy.destroy(); });
      pipeline(req, proxy, () => {});
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return reject(res, 405);
    try {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.')) || pathname.endsWith('.map')) return reject(res, 404);
      const file = await realpath(resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)));
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return reject(res, 404);
      const metadata = await stat(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-length': metadata.size, 'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
      if (req.method === 'HEAD') return res.end();
      pipeline(createReadStream(file), res, () => {});
    } catch { reject(res, 404); }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { dist: { type: 'string' }, 'token-file': { type: 'string' }, api: { type: 'string', default: 'http://127.0.0.1:8787' }, port: { type: 'string', default: '5178' }, lan: { type: 'boolean', default: false } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const server = await createFrontendServer({ dist: values.dist, tokenFile: values['token-file'], api: values.api, port, lan: values.lan });
  server.listen(port, values.lan ? '0.0.0.0' : '127.0.0.1', () => process.stdout.write(`Scorebook http://127.0.0.1:${port} (LAN ${values.lan ? 'enabled' : 'disabled'})\n`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
