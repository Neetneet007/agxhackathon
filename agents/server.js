#!/usr/bin/env node
// Starts the durable agent runtime and its read-only API.
//   node agents/server.js
// Environment (all optional):
//   AGENTS_PORT=5200            API port
//   RUNNER_URL=http://127.0.0.1:5190   live runner (must be local)
//   AGENTS_DATA=agents/data     durable log and journals
//   AGENTS=weather              comma list; default is every folder with AGENT.md + tools.js
//   POLL_MS=1000                how often to poll GET /state (real milliseconds)
//   AGENT_MODEL=claude-haiku-5-5  or "off" for rule-only; needs ANTHROPIC_API_KEY
//   WEATHER_DAY=calm|monsoon|hurricane   WEATHER_SOURCE=sim|nws   WEATHER_SCRIPT=path/to/readings.json (see agents/weather/feed.js)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime, discoverAgents } from './runtime/runtime.js';
import { startApi } from './runtime/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const port = Number(env.AGENTS_PORT ?? 5200);
const RESERVED = new Set([4040, 5174, 5175, 5176, 5177, 5180, 5190, 5191, 6175, 6176, 6177]);
if (RESERVED.has(port)) { console.error(`port ${port} is reserved by another component`); process.exit(1); }

let agents = await discoverAgents(here);
if (env.AGENTS) { const want = new Set(env.AGENTS.split(',').map(s => s.trim())); agents = agents.filter(a => want.has(a.name)); }

const rt = new Runtime({
  dataDir: path.resolve(env.AGENTS_DATA || path.join(here, 'data')),
  agents,
  runnerUrl: env.RUNNER_URL || 'http://127.0.0.1:5190',
  pollMs: Number(env.POLL_MS || 1000),
  config: { weatherSource: env.WEATHER_SOURCE || 'sim', weatherScript: env.WEATHER_SCRIPT || null, weatherDay: env.WEATHER_DAY || 'calm' },
});
const server = await startApi(rt, { port });
const addr = server.address();
console.log(`[agents] API listening on http://127.0.0.1:${addr.port}  agents: ${agents.map(a => a.name).join(', ') || 'none'}  ` +
  `model: ${rt.model.available() ? rt.model.model : `off (${rt.model.disabledReason}) — rule-only`}  log: ${rt.log.file} (${rt.log.entries.length} entries replayed)`);
rt.start();

const shutdown = () => { rt.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
