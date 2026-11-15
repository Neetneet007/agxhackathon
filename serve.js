#!/usr/bin/env node
// Dashboard server: static files + /api endpoints for Claude explanations.
// Usage: ANTHROPIC_API_KEY=... node serve.js [port=5180]
// Without credentials the dashboard still works, using the planner's own explanations.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmEnabled, explainShift, answerWhy, describeError } from './src/llm.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = +(process.argv[2] || process.env.PORT || 5180);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/markdown', '.jpg': 'image/jpeg' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 300_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function api(req, res, url) {
  if (url === '/api/llm/status') return json(res, 200, { enabled: llmEnabled() });
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad JSON' }); }
  if (!llmEnabled()) return json(res, 200, { llm: false, error: 'No ANTHROPIC_API_KEY set — using planner explanations' });
  try {
    if (url === '/api/explain') return json(res, 200, { llm: true, ...(await explainShift(body.facts || {})) });
    if (url === '/api/why') {
      const q = String(body.question || '').slice(0, 500);
      if (!q) return json(res, 400, { error: 'question required' });
      return json(res, 200, { llm: true, ...(await answerWhy(q, body.facts || {})) });
    }
    return json(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    console.error('[llm]', err.message);
    return json(res, 200, { llm: false, error: describeError(err) });
  }
}

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/')) return void api(req, res, url);
  if (url === '/') { res.writeHead(302, { Location: '/dashboard/' }); return res.end(); }
  if (url.endsWith('/')) url += 'index.html';
  const file = path.join(root, url);
  if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`Fleet Command Center → http://localhost:${port}/  (Claude explanations: ${llmEnabled() ? 'ON' : 'off — set ANTHROPIC_API_KEY'})`));
