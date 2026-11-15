// Client for the live runner (agopen/live.js, port 5190). It is an allowlist: only the calls in
// the integration contract can leave this process. Everything else (releasing a tractor at the
// depot, tractor commands, breakdown/repair events, drafts, start) is refused before any network
// traffic, so no agent and no model output can ever reach those endpoints.

export class ForbiddenCallError extends Error {}

const ALLOWED = [
  ['GET', /^\/state$/],
  ['GET', /^\/farm$/],
  ['POST', /^\/hold$/],
  ['DELETE', /^\/hold\/[A-Za-z0-9._-]+$/],
  ['POST', /^\/agent\/say$/],
  ['POST', /^\/event$/],
];
const EVENT_TYPES_ALLOWED = new Set(['priority_change']);

export function checkAllowed(method, url, body) {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(url))) return `${method} ${url} is not in the integration contract`;
  if (url === '/event' && !EVENT_TYPES_ALLOWED.has(body?.type)) return `POST /event with type "${body?.type}" is not allowed (only priority_change)`;
  return null;
}

export class RunnerClient {
  constructor(base = 'http://127.0.0.1:5190', { timeoutMs = 2500 } = {}) {
    const u = new URL(base);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`runner must be local, got ${u.hostname}`);
    this.base = base.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async request(method, url, body) {
    const why = checkAllowed(method, url, body);
    if (why) throw new ForbiddenCallError(why);
    const res = await fetch(this.base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text reply */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  getState() { return this.request('GET', '/state'); }
  getFarm() { return this.request('GET', '/farm'); }
  postHold(hold) { return this.request('POST', '/hold', hold); }
  deleteHold(id) { return this.request('DELETE', `/hold/${encodeURIComponent(id)}`); }
  say(msg) { return this.request('POST', '/agent/say', msg); }
  postEvent(evt) { return this.request('POST', '/event', evt); }
}

// "HH:MM" plan clock → minutes after 06:00 (the planner's minute 0).
export function clockToMinute(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(clock || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) - 6 * 60;
}

export function minuteToClock(min) {
  const t = Math.round(min) + 6 * 60;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
