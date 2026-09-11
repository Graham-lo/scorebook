import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createFrontendServer } from './serve-frontend.mjs';

for (const lan of [false, true]) test(`${lan ? 'LAN' : 'loopback'} frontend serves assets, streams API and rejects credential exposure`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'scorebook-entry-'));
  const dist = join(dir, 'dist'); await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<html>Scorebook</html>');
  await writeFile(join(dir, 'token'), 'test-private-token');
  await symlink(join(dir, 'token'), join(dist, 'secret.txt'));
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ready\ndata: {"ready":true}\n\n');
    res.end('event: done\ndata: {}\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let addresses = [{ family: 'IPv4', address: '192.168.124.9', internal: false }, { family: 'IPv4', address: '203.0.113.2', internal: false }, { family: 'IPv4', address: '100.72.84.39', internal: false }];
  const options = { dist, tokenFile: join(dir, 'token'), api: `http://127.0.0.1:${upstream.address().port}`, port: 5178, lan, interfaces: () => ({ en0: addresses }) };
  const app = await createFrontendServer(options);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => app.close(r)), new Promise(r => upstream.close(r))]); await rm(dir, { recursive: true }); });
  function request(path, extra = {}, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: app.address().port, path, method, headers: { host: '127.0.0.1:5178', ...extra } }, res => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      }); req.on('error', reject); req.end(body);
    });
  }
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/secret.txt')).status, 404);
  assert.equal((await request('/%2e%2e/token')).status, 404);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/', { host: 'attacker.invalid:5178' })).status, 403);
  assert.equal((await request('/api/v1/calls', { origin: 'https://attacker.invalid' }, 'POST', '{}')).status, 403);
  assert.equal((await request('/api/v1/calls', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/v1/calls', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'POST', '{}')).status, 403);
  assert.equal((await request('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status, 200);
  assert.equal((await request('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request('/', { host: 'localhost:5178' })).status, 200);
  assert.equal((await request('/', { host: '192.168.124.9:5178', origin: 'http://192.168.124.9:5178' })).status, lan ? 200 : 403);
  assert.equal((await request('/', { host: '192.168.124.10:5178' })).status, 403);
  assert.equal((await request('/', { host: '203.0.113.2:5178' })).status, 403);
  assert.equal((await request('/', { host: '100.72.84.39:5178', origin: 'http://100.72.84.39:5178' })).status, lan ? 200 : 403);
  assert.equal((await request('/', { host: '100.200.0.1:5178' })).status, 403);
  assert.equal((await request('/', { host: '192.168.124.9:5178', origin: 'http://attacker.invalid:5178' })).status, 403);
  if (lan) {
    addresses = [{ family: 'IPv4', address: '192.168.124.11', internal: false }];
    assert.equal((await request('/', { host: '192.168.124.9:5178' })).status, 403);
    assert.equal((await request('/', { host: '192.168.124.11:5178' })).status, 200);
  }
  const result = await request('/api/v1/chat/runs?cursor=1', { authorization: 'Bearer browser-value', cookie: 'not-forwarded=1', 'content-type': 'application/json' }, 'POST', '{"message":"hello"}');
  assert.equal(result.status, 200);
  assert.match(result.body, /event: ready/); assert.match(result.body, /event: done/);
  assert.equal(result.body.includes('test-private-token'), false);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(calls[0].path, '/v1/chat/runs?cursor=1');
  assert.equal(calls[0].headers.authorization, 'Bearer test-private-token');
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(calls[0].body, '{"message":"hello"}');
  if (lan) {
    assert.equal((await request('/api/v1/calls', { host: '192.168.124.11:5178', origin: 'http://192.168.124.11:5178' }, 'POST', '{}')).status, 200);
    assert.equal(calls[1].headers.origin, 'http://127.0.0.1:5178');
    assert.equal(calls[1].headers.authorization, 'Bearer test-private-token');
  }
  await assert.rejects(createFrontendServer({ ...options, api: 'http://example.com' }));
});
