// Read-only HTTP API for the runtime (default port 5200). The only write is POST /agents/<name>/wake.
import http from 'node:http';

export function startApi(rt, { port = 5200, host = '127.0.0.1' } = {}) {
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj, null, 1));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/$/, '') || '/';
    const agent = name => rt.agents.find(a => a.name === name);
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST' }); return res.end(); }
      if (req.method === 'POST') {
        // A person reports something done (e.g. an inspection). No agent tool can call this.
        const pm = p.match(/^\/people\/([^/]+)\/([^/]+)$/);
        if (pm) {
          let body = '';
          req.on('data', c => { body += c; if (body.length > 10_000) req.destroy(); });
          req.on('end', async () => {
            let b = {};
            try { b = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'bad JSON' }); }
            const r = await rt.person(pm[1], pm[2], b);
            json(res, r.ok ? 200 : 400, r);
          });
          return;
        }
        const m = p.match(/^\/agents\/([^/]+)\/wake$/);
        if (!m) return json(res, 405, { error: 'read-only API; the only POSTs are /agents/<name>/wake and the person actions under /people/' });
        if (!rt.requestWake(m[1])) return json(res, 404, { error: `no agent ${m[1]}` });
        return json(res, 202, { queued: true, agent: m[1], note: 'wakes on the next poll' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      if (p === '/health') {
        return json(res, 200, {
          ok: true, startedAt: rt.startedAt, runner: { url: rt.runner.base, ...rt.runnerStatus }, clock: rt.state?.clock ?? null,
          model: { enabled: rt.model.available(), model: rt.model.model, disabledReason: rt.model.disabledReason },
          log: { file: rt.log.file, entries: rt.log.entries.length, tornLinesIgnored: rt.log.torn },
          agents: rt.agents.map(a => a.name),
        });
      }
      if (p === '/agents') return json(res, 200, { agents: rt.agents.map(a => rt.agentSummary(a)) });
      let m = p.match(/^\/agents\/([^/]+)$/);
      if (m) { const a = agent(m[1]); return a ? json(res, 200, { ...rt.agentSummary(a), instructions: a.instructions, tools: rt.allTools(a).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })) }) : json(res, 404, { error: 'no such agent' }); }
      m = p.match(/^\/agents\/([^/]+)\/runs$/);
      if (m) {
        if (!agent(m[1])) return json(res, 404, { error: 'no such agent' });
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 50);
        const runs = rt.runs.get(m[1]).slice(-limit).reverse().map(r => {
          const { toolSeq, sent, caller, ...rest } = r;
          return { ...rest, steps: rt.log.entries.filter(e => e.run === r.id).map(e => ({ seq: e.seq, ts: e.ts, kind: e.kind, tool: e.tool, input: e.input, result: e.result, error: e.error, stop_reason: e.stop_reason, text: e.text, toolUses: e.toolUses })) };
        });
        return json(res, 200, { agent: m[1], runs });
      }
      if (p === '/messages') {
        const since = Number(url.searchParams.get('since')) || 0;
        const list = rt.messages.filter(x => x.n > since).map(x => ({ ...x, mirrored: rt.effects.get(`say:${x.id}`)?.status ?? null }));
        return json(res, 200, { messages: list, next: rt.messages.length });
      }
      if (p === '/memory') {
        const key = url.searchParams.get('key');
        if (key) { const e = rt.memory.get(key); return e ? json(res, 200, { key, value: e.value, by: e.by, ts: e.ts, history: e.history }) : json(res, 404, { error: 'no such key' }); }
        return json(res, 200, { memory: Object.fromEntries([...rt.memory.entries()].map(([k, v]) => [k, { value: v.value, by: v.by, ts: v.ts, revisions: v.history.length }])) });
      }
      if (p === '/effects') return json(res, 200, { effects: [...rt.effects.values()].map(({ nextTry, ...f }) => f) });
      return json(res, 404, { error: 'not found', endpoints: ['/health', '/agents', '/agents/<name>', '/agents/<name>/runs', '/messages?since=<n>', '/memory', '/memory?key=<k>', '/effects', 'POST /agents/<name>/wake'] });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
