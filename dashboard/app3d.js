// Fleet Command Center (3D). Runs the real coordinator (or the FCFS baseline) live,
// renders it in 3D, and turns every plan shift into a notification explained by
// Claude (via /api on the local server) — falling back to the planner's own text.
import { Simulator } from '../src/simulator.js';
import { Coordinator } from '../src/coordinator.js';
import { Baseline } from '../src/baseline.js';
import { fmtTime, JOB_VERB, IMPLEMENT_FOR, START_HOUR } from '../src/model.js';
import { readFeeds, SOURCES, sourceName } from '../src/sources.js';
import { FarmScene } from './scene3d.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TC = { T1: 'var(--t1)', T2: 'var(--t2)', T3: 'var(--t3)' };
const tc = id => TC[id] || 'var(--info)';
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m - START_HOUR * 60; };

let scenario, sim, disp, scene, mode = 'C', playing = false, speed = 15, acc = 0, lastTs = 0;
let injected = [], newJobSeq = 1, llmOn = false, lastLog = 0, lastUi = 0, uiDirty = true;
const shifts = []; // {id, entry, facts, title, reason, by}

// ------------------------------------------------------------------ boot
// Live mode (?live=1, served by agopen/live.js): this page keeps its own copy of the planner's world and
// replays the live run's log into it, so the 3D farm shows the same day the AgOpenWeb tractors are working.
const LIVE = new URLSearchParams(location.search).has('live');
let liveApplied = 0;
async function liveSync() {
  let r;
  try { r = await (await fetch('/replay', { cache: 'no-store' })).json(); } catch { return; }
  let stepped = false;
  const stepTo = (t) => { while (sim.time < t && !sim.finished) { sim.step(); stepped = true; } };
  for (; liveApplied < r.entries.length; liveApplied++) {
    const en = r.entries[liveApplied];
    stepTo(en.t);
    if (en.kind === 'event') { injected.push(en.event); sim.inject(structuredClone(en.event)); }
    else { const a = sim.tractor(en.tractor)?.action; if (a && (a.kind === 'refuel' || a.kind === 'swap')) a.left = en.kind === 'hold' ? en.left : 1; }
    stepped = true;
  }
  stepTo(r.time);
  if (stepped) { processLog(); uiDirty = true; }
}

async function boot() {
  scenario = await (await fetch('../scenario.json')).json();
  try { llmOn = (await (await fetch('/api/llm/status')).json()).enabled; } catch { llmOn = false; }
  $('llmPill').textContent = llmOn ? '✦ Claude explanations on' : 'Planner explanations · set ANTHROPIC_API_KEY for Claude';
  $('llmPill').classList.toggle('on', llmOn);
  $('nField').innerHTML = scenario.fields.map(f => `<option value="${f.id}">${f.id} ${esc(f.name)}</option>`).join('');
  $('opTractor').innerHTML = scenario.tractors.map(t => `<option value="${t.id}">${t.id} ${esc(t.name)}</option>`).join('');
  scene = new FarmScene($('stage'), scenario, { onPick: showPopover });
  $('loading').remove();
  reset();
  if (LIVE) { $('play').disabled = true; $('play').textContent = 'Live'; setInterval(liveSync, 800); liveSync(); }
  requestAnimationFrame(loop);
}

function reset() {
  disp = mode === 'C' ? new Coordinator() : new Baseline();
  sim = new Simulator(scenario, disp, { scriptedEvents: $('scripted').checked });
  injected = []; shifts.length = 0; lastLog = 0; acc = 0;
  $('toasts').innerHTML = ''; $('thread').innerHTML = '';
  setPlaying(false); hidePopover();
  processLog(); uiDirty = true;
}

function setPlaying(p) { playing = p && !sim.finished; $('play').textContent = playing ? '❚❚ Pause' : '▶ Run'; }

function inject(evt) {
  if (LIVE) { fetch('/event', { method: 'POST', body: JSON.stringify({ source: 'operator', ...evt }) }); return; }   // the live run applies it; we see it via the replay log
  const e = { source: 'operator', ...evt, time: sim.time };
  injected.push(e); sim.inject(e); sim.processEvents();
  processLog(); uiDirty = true;
}

function loop(ts) {
  const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 0; lastTs = ts;
  if (playing && !LIVE) {
    acc += dt * speed;
    let n = 0;
    while (acc >= 1 && !sim.finished) { sim.step(); acc -= 1; n++; }
    if (n) { processLog(); uiDirty = true; }
    if (sim.finished) setPlaying(false);
  }
  scene.update(sim, mode === 'C' ? disp.plan : null, dt);
  if (uiDirty && ts - lastUi > 120) { renderUi(); lastUi = ts; uiDirty = false; }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ shifts → notifications
function triggerFor(entry) {
  // the event (with its data source) that caused this plan shift, if any
  for (let i = sim.log.indexOf(entry) - 1; i >= 0 && sim.log[i].time === entry.time; i--) {
    const e = sim.log[i];
    if (e.type === 'event' || e.type === 'submit') return e;
  }
  return null;
}

function processLog() {
  for (; lastLog < sim.log.length; lastLog++) {
    const e = sim.log[lastLog];
    if (e.type === 'event') {
      const ev = e.event || {};
      const where = ev.tractor ? sim.tractor(ev.tractor) : ev.cells ? { x: ev.cells[0][0], y: ev.cells[0][1] } : ev.job ? sim.jobField(sim.jobs.get(ev.job)) : null;
      if (where) scene.pulse(where, 0xff3b30);
      flashSource(e.source);
    }
    if (e.type === 'submit' && e.event) { for (const j of e.event.jobs) scene.pulse(sim.jobField(sim.jobs.get(j.id)), 0x2f7fd6); flashSource(e.source); }
    if (e.type === 'plan' && mode === 'C') onShift(e);
    if (e.type === 'safety') toast({ cls: 'event', title: 'Safety hold', reason: e.text, time: e.clock });
  }
}

function factsForShift(entry) {
  const trig = triggerFor(entry);
  const p = disp.plan;
  return {
    clock: entry.clock,
    cause: entry.cause,
    trigger: trig ? { what: trig.text, source: trig.source ? sourceName(trig.source) : null, signal: trig.signal || null } : null,
    planner_headline: entry.text,
    planner_changes: entry.lines || [],
    planner_summary: entry.footer,
    data_sources_now: readFeeds(sim).map(f => ({ source: f.name, reading: f.text, alert: f.alert })),
    tractors: sim.tractors.map(t => ({ id: t.id, name: t.name, status: t.status, fuel_pct: Math.round(100 * t.fuel / t.fuelCapacity), implements: t.implements, queue: (p?.assign[t.id] || []).map(id => ({ job: sim.label(sim.jobs.get(id)), finish: p.schedule[id] ? fmtTime(p.schedule[id].end) : null, deadline: fmtTime(sim.jobs.get(id).deadline) })) })),
    late_or_unscheduled: [...(p?.late || []).map(l => `${sim.label(sim.jobs.get(l.id))}: ${Math.round(l.lateness)} min late (${l.approved ? 'approved' : 'needs sign-off'})`), ...(p?.unassigned || []).map(u => `${sim.label(sim.jobs.get(u.id))}: does not fit today`)],
  };
}

function onShift(entry) {
  if (entry.cause === 'initial' && shifts.length) return;
  const facts = factsForShift(entry);
  const trig = facts.trigger;
  const s = {
    id: shifts.length, entry, facts,
    title: entry.text.length > 70 ? entry.text.slice(0, 67) + '…' : entry.text,
    reason: entry.cause === 'initial' ? entry.footer : (entry.lines || []).slice(0, 2).join(' ') || entry.footer,
    by: 'Planner', pending: llmOn,
    source: trig?.source ? SOURCES[Object.keys(SOURCES).find(k => SOURCES[k].name === trig.source)] : null,
  };
  shifts.push(s);
  const el = toast({ cls: trig?.source ? 'event' : '', shift: s });
  if (llmOn) {
    fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts }) })
      .then(r => r.json())
      .then(r => {
        s.pending = false;
        if (r.llm) { s.title = r.title; s.reason = r.reason; s.by = 'Claude'; }
        else s.note = r.error;
        fillToast(el, s);
      })
      .catch(() => { s.pending = false; fillToast(el, s); });
  }
  uiDirty = true;
}

function toast({ cls = '', shift = null, title = '', reason = '', time = '' }) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  box.prepend(el);
  if (shift) fillToast(el, shift); else el.innerHTML = `<div class="th"><span class="tt">${esc(title)}</span><span class="tm">${esc(time)}</span></div><div class="rs">${esc(reason)}</div>`;
  while (box.children.length > 4) box.lastElementChild.remove();
  let timer = setTimeout(() => dismiss(el), 11000);
  el.onmouseenter = () => clearTimeout(timer);
  el.onmouseleave = () => { timer = setTimeout(() => dismiss(el), 6000); };
  return el;
}
function dismiss(el) { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }

function fillToast(el, s) {
  const src = s.facts.trigger?.source;
  el.innerHTML = `<div class="th"><span class="tt">${esc(s.title)}</span><span class="tm">${esc(s.entry.clock)}</span></div>
    ${src ? `<span class="src">${s.source?.icon ?? '•'} ${esc(src)}${s.facts.trigger.signal ? ` — ${esc(s.facts.trigger.signal)}` : ''}</span>` : ''}
    <div class="rs ${s.pending ? 'typing' : ''}">${esc(s.pending ? 'Claude is summarising' : s.reason)}</div>
    <div class="by">${s.by === 'Claude' ? '<span class="badge claude">✦ Claude</span>' : '<span class="badge">planner</span>'}${s.note ? `<span title="${esc(s.note)}">·  fallback</span>` : ''}
      <span class="acts"><button class="btn" data-more>Details</button><button class="btn primary" data-why>Why?</button></span></div>`;
  el.querySelector('[data-why]').onclick = () => openAsk(`shift:${s.id}`, 'Why did the plan change?');
  el.querySelector('[data-more]').onclick = ev => {
    const ul = el.querySelector('ul');
    if (ul) return ul.remove();
    el.insertAdjacentHTML('beforeend', `<ul>${(s.entry.lines || []).map(l => `<li>${esc(l)}</li>`).join('')}<li>${esc(s.entry.footer || '')}</li></ul>`);
    ev.target.blur();
  };
}

function flashSource(id) {
  if (!id) return;
  requestAnimationFrame(() => {
    const el = document.querySelector(`.src[data-src="${id}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  });
}

// ------------------------------------------------------------------ copilot ("why?")
function openAsk(ctx, question) {
  $('ask').hidden = false;
  refreshAskCtx(ctx);
  if (question) ask(question);
  else $('askInput').focus();
}

function refreshAskCtx(select) {
  const opts = [];
  shifts.slice(-8).reverse().forEach(s => opts.push([`shift:${s.id}`, `Change at ${s.entry.clock} — ${s.title}`]));
  for (const j of sim.jobs.values()) opts.push([`job:${j.id}`, `Job ${sim.label(j)}`]);
  for (const t of sim.tractors) opts.push([`tractor:${t.id}`, `Tractor ${t.id} ${t.name}`]);
  const cur = select || $('askCtx').value;
  $('askCtx').innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  if (opts.some(o => o[0] === cur)) $('askCtx').value = cur;
  const kind = $('askCtx').value.split(':')[0];
  const chips = kind === 'job' ? ['Why this tractor?', 'Will it make the deadline?', 'What were the alternatives?']
    : kind === 'tractor' ? ['What is it doing next?', 'Why is it routed this way?', 'Is fuel a problem?']
      : ['Why did the plan change?', 'Which data source triggered it?', 'What should I do?'];
  $('askChips').innerHTML = chips.map(c => `<button type="button">${esc(c)}</button>`).join('');
  $('askMode').textContent = llmOn ? 'Claude, grounded in the planner' : 'planner answers (no API key)';
}

function factsForAsk(ctx) {
  const [kind, id] = ctx.split(':');
  const base = { clock: fmtTime(sim.time), data_sources_now: readFeeds(sim).map(f => ({ source: f.name, reading: f.text, alert: f.alert })) };
  if (kind === 'shift') {
    const s = shifts.find(x => String(x.id) === id);
    return { ...base, about: 'plan change', ...s.facts };
  }
  if (kind === 'job') {
    const j = sim.jobs.get(id);
    return { ...base, about: `job ${sim.label(j)}`, job: { id: j.id, task: JOB_VERB[j.type], field: sim.fields.get(j.fieldId).name, priority: j.priority, deadline: fmtTime(j.deadline), acres_left: +j.remaining.toFixed(1), status: j.status }, planner_reasoning: mode === 'C' ? disp.why(sim, id) : ['FCFS baseline: earliest-submitted job a free tractor can do.'], recent_changes: shifts.slice(-3).map(s => s.facts.planner_headline) };
  }
  const t = sim.tractor(id);
  const p = mode === 'C' ? disp.plan : null;
  return { ...base, about: `tractor ${t.id}`, tractor: { id: t.id, name: t.name, status: t.status, fault: t.fault || null, fuel_pct: Math.round(100 * t.fuel / t.fuelCapacity), mounted: t.mounted, implements: t.implements, doing: t.action ? t.action.kind + (t.action.purpose ? ` (${t.action.purpose})` : '') : 'idle', route_cells_left: t.action?.path?.length ?? 0 }, queue: (p?.assign[t.id] || []).map(jid => ({ job: sim.label(sim.jobs.get(jid)), finish: fmtTime(p.schedule[jid].end), deadline: fmtTime(sim.jobs.get(jid).deadline) })), closed_crossings: sim.nav.blockedCells().map(c => c.name), recent_changes: shifts.slice(-3).map(s => s.facts.planner_headline) };
}

function plannerAnswer(ctx) {
  const [kind, id] = ctx.split(':');
  if (kind === 'job') return mode === 'C' ? disp.why(sim, id).join(' ') : 'The FCFS baseline has no reasoning: each free tractor takes the earliest-submitted job it can do.';
  if (kind === 'shift') {
    const s = shifts.find(x => String(x.id) === id);
    const trig = s.facts.trigger;
    const lines = s.entry.lines || [];
    return [trig?.source ? `Triggered by ${trig.source}${trig.signal ? ` (${trig.signal})` : ''}.` : '', s.entry.text, ...lines.slice(0, 3), lines.length > 3 ? `(+${lines.length - 3} more changes under Details.)` : ''].filter(Boolean).join(' ');
  }
  const t = sim.tractor(id); const p = disp.plan;
  return `${t.id} ${t.name}: ${t.status === 'broken' ? 'out of service' : t.action?.kind || 'idle'}, ${Math.round(100 * t.fuel / t.fuelCapacity)}% fuel. Queue: ${(p?.assign[t.id] || []).join(', ') || 'none'}.`;
}

async function ask(q) {
  const ctx = $('askCtx').value;
  const th = $('thread');
  th.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div>`);
  const el = document.createElement('div'); el.className = 'msg ai'; el.innerHTML = '<span class="typing">Thinking</span>';
  th.append(el); th.scrollTop = th.scrollHeight;
  let answer = null, by = 'planner';
  if (llmOn) {
    try {
      const r = await (await fetch('/api/why', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, facts: factsForAsk(ctx) }) })).json();
      if (r.llm) { answer = r.answer; by = '✦ Claude'; }
    } catch { /* fall through */ }
  }
  if (!answer) answer = plannerAnswer(ctx);
  el.innerHTML = `${esc(answer)}<div class="by">${by}</div>`;
  th.scrollTop = th.scrollHeight;
}

// ------------------------------------------------------------------ UI panels
function jobState(j) {
  const p = mode === 'C' ? disp.plan : null;
  const w = sim.tractors.find(t => t.jobId === j.id && t.status === 'ok');
  if (j.status === 'cancelled') return ['Dropped', 'bad'];
  if (j.status === 'done') return j.doneAt > j.deadline ? [`Done ${j.doneAt - j.deadline}m late`, 'late'] : ['Done', 'done'];
  if (w?.action?.kind === 'work') return ['Working', ''];
  if (p?.unassigned.some(u => u.id === j.id)) return ['Won’t fit today', 'bad'];
  const l = p?.late.find(x => x.id === j.id);
  if (l) return [l.approved ? 'Late · approved' : 'Late · needs OK', 'late'];
  if (w) return [w.action?.kind === 'goto' ? 'En route' : 'Assigned', ''];
  return ['Queued', ''];
}
const owner = id => { const p = mode === 'C' ? disp.plan : null; return p ? Object.keys(p.assign).find(t => p.assign[t].includes(id)) : sim.tractors.find(t => t.jobId === id)?.id; };

function renderUi() {
  $('clock').textContent = fmtTime(sim.time) + (sim.finished ? ' ✓' : '');
  const p = mode === 'C' ? disp.plan : null;
  const jobs = [...sim.jobs.values()];
  const done = jobs.filter(j => j.status === 'done');
  const onTime = done.filter(j => j.doneAt <= j.deadline).length;
  const travel = sim.tractors.reduce((a, t) => a + t.stats.travel, 0);
  const viol = sim.violations.filter(v => !['unfinished', 'deadline-flagged'].includes(v.kind)).length;
  const k = (v, l, c = '') => `<div class="kpi"><b class="${c}">${v}</b><span>${l}</span></div>`;
  $('kpis').innerHTML = k(`${done.length}/${jobs.filter(j => j.status !== 'cancelled').length}`, 'jobs done') + k(onTime, 'on time') + k(travel, 'travel min') + k(viol, 'violations', viol ? 'bad' : 'good') + (p ? k(fmtTime(p.finish), 'plan finish') : '');

  // decisions
  const dec = [];
  if (p) {
    for (const l of p.late.filter(l => !l.approved)) dec.push(`<div class="item"><span><b>${esc(sim.label(sim.jobs.get(l.id)))}</b> can’t make ${fmtTime(sim.jobs.get(l.id).deadline)} — ${l.tractor} by ${fmtTime(l.end)}</span><span class="row"><button class="btn" data-op="approve" data-j="${l.id}">Approve late</button><button class="btn danger" data-op="drop" data-j="${l.id}">Drop</button><button class="btn" data-ask="job:${l.id}">Why?</button></span></div>`);
    for (const u of p.unassigned) dec.push(`<div class="item"><span><b>${esc(sim.label(sim.jobs.get(u.id)))}</b> won’t fit in today’s shift</span><span class="row"><button class="btn danger" data-op="drop" data-j="${u.id}">Drop</button><button class="btn" data-ask="job:${u.id}">Why?</button></span></div>`);
  }
  $('decisions').innerHTML = dec.length ? `<div class="decision glass"><b>Needs your decision (${dec.length})</b>${dec.join('')}</div>` : '';

  // fleet
  $('fleet').innerHTML = sim.tractors.map(t => {
    const pct = 100 * t.fuel / t.fuelCapacity;
    const q = p ? (p.assign[t.id] || []) : t.jobId ? [t.jobId] : [];
    const late = new Set(p ? p.late.map(l => l.id) : []);
    const st = t.status === 'broken' ? `⚠ Out of service${t.fault ? ` · ${t.fault}` : ''}` : !t.action ? 'Idle' : t.action.kind === 'goto' ? `Driving to ${t.action.purpose === 'job' ? sim.fields.get(sim.jobs.get(t.jobId)?.fieldId)?.name : 'depot'} (${t.action.purpose})` : t.action.kind === 'work' ? `${JOB_VERB[sim.jobs.get(t.jobId).type]}ing · ${Math.round(100 * (1 - sim.jobs.get(t.jobId).remaining / sim.jobs.get(t.jobId).acres))}%` : t.action.kind === 'refuel' ? 'Refuelling' : `Fitting ${t.action.impl}`;
    return `<div class="trow" data-focus="tractor:${t.id}"><span class="dot" style="background:${tc(t.id)}"></span><span class="name">${t.id} ${esc(t.name)}</span><span class="muted">${t.mounted}</span>
      <span class="st">${esc(st)}</span><div class="fuel ${pct < 25 ? 'low' : ''}"><i style="width:${pct}%"></i></div>
      <div class="q">${q.map(id => `<span class="chip ${late.has(id) ? 'late' : ''}" data-ask="job:${id}">${id}${p?.schedule[id] ? ' →' + fmtTime(p.schedule[id].end) : ''}</span>`).join('') || '<span class="muted">no queue</span>'}</div></div>`;
  }).join('');

  // jobs
  $('jobCount').textContent = `${done.length}/${jobs.length}`;
  $('jobs').innerHTML = jobs.map(j => {
    const [lab, cls] = jobState(j);
    const o = j.status === 'done' ? j.doneBy : owner(j.id);
    const fin = j.status === 'done' ? fmtTime(j.doneAt) : p?.schedule[j.id] ? fmtTime(p.schedule[j.id].end) : '—';
    return `<div class="jrow" data-focus="job:${j.id}"><b>${j.id}</b><span>${JOB_VERB[j.type]} ${esc(sim.fields.get(j.fieldId).name)}</span><span class="chip ${cls}">${lab}</span>
      <span class="meta">${j.priority} · due ${fmtTime(j.deadline)} · ${o ? `<span style="color:${tc(o)};font-weight:600">${o}</span>` : '—'} · finish ${fin}</span><div class="jbar"><i style="width:${100 * (1 - j.remaining / j.acres)}%"></i></div></div>`;
  }).join('');

  // sources
  const feeds = readFeeds(sim);
  $('srcCount').textContent = `${feeds.length} feeds${feeds.some(f => f.alert) ? ` · ${feeds.filter(f => f.alert).length} alert` : ''}`;
  const html = feeds.map(f => `<div class="src ${f.alert ? 'alert' : ''}" data-src="${f.id}"><span class="ic">${f.icon}</span><span class="nm">${esc(f.name)}</span><span class="rd">${esc(f.text)}${f.since != null ? ` · ${fmtTime(f.since)}` : ''}</span></div>`).join('');
  if ($('sources').dataset.h !== html) { $('sources').innerHTML = html; $('sources').dataset.h = html; }

  // operator lists
  const blocked = new Set(sim.nav.blockedCells().map(c => `${c.x},${c.y}`));
  $('opBridges').innerHTML = (scenario.map.features?.bridges || []).map((b, i) => {
    const closed = b.cells.every(([x, y]) => blocked.has(`${x},${y}`));
    return `<button class="btn ${closed ? '' : 'danger'}" data-op="${closed ? 'unblock' : 'block'}" data-b="${i}">${closed ? 'Reopen' : 'Close'} ${esc(b.name)}</button>`;
  }).join('');
  const open = sim.openJobs();
  const ph = open.map(j => `<option value="${j.id}">${esc(sim.label(j))} (${j.priority}, ${fmtTime(j.deadline)})</option>`).join('');
  if ($('pJob').dataset.h !== ph) { const c = $('pJob').value; $('pJob').innerHTML = ph; $('pJob').dataset.h = ph; if (open.some(j => j.id === c)) $('pJob').value = c; }
  $('step').disabled = $('play').disabled = sim.finished;
  if ($('timelineDetails').open) renderGantt();
  if (popState) showPopover(popState.data, popState.at, true);
}

function renderGantt() {
  const L = 70, R = 1000, rowH = 22, top = 16, span = sim.horizon;
  const X = t => L + (Math.max(0, Math.min(span, t)) / span) * (R - L);
  const H = top + sim.tractors.length * rowH + 4;
  const fill = (k, id) => ({ work: tc(id), travel: 'var(--travel)', refuel: 'var(--refuel)', swap: 'var(--swap)', broken: 'var(--broken)' }[k]);
  const o = [`<svg viewBox="0 0 ${R + 10} ${H}">`];
  for (let h = 0; h <= span; h += 60) o.push(`<line x1="${X(h)}" y1="${top - 3}" x2="${X(h)}" y2="${H}" stroke="var(--line)"/><text x="${X(h)}" y="10" font-size="9" text-anchor="middle" fill="var(--muted)">${fmtTime(h)}</text>`);
  const p = mode === 'C' ? disp.plan : null;
  sim.tractors.forEach((t, i) => {
    const y = top + i * rowH;
    o.push(`<text x="2" y="${y + 13}" font-size="10" font-weight="600" fill="${tc(t.id)}">${t.id} ${esc(t.name)}</text>`);
    for (const s of t.history || []) { const f = fill(s.kind, t.id); if (f) o.push(`<rect x="${X(s.start)}" y="${y + 2}" width="${Math.max(X(s.end) - X(s.start), .5)}" height="${rowH - 6}" fill="${f}" rx="1.5"/>`); }
    if (p && t.status === 'ok') for (const l of p.evals[t.id]?.legs || []) {
      const s0 = Math.max(l.start, sim.time); if (l.end <= s0) continue;
      const f = fill(l.kind === 'travel-depot' ? 'travel' : l.kind, t.id); if (!f) continue;
      const w = X(l.end) - X(s0);
      o.push(`<rect x="${X(s0)}" y="${y + 4}" width="${Math.max(w, .5)}" height="${rowH - 10}" fill="${f}" opacity=".35" rx="1.5"/>`);
      if (l.kind === 'work' && w > 24) o.push(`<text x="${X(s0) + w / 2}" y="${y + 13}" font-size="8.5" text-anchor="middle" fill="var(--ink)">${l.jobId}</text>`);
    }
    if (p) for (const id of p.assign[t.id] || []) { const j = sim.jobs.get(id); o.push(`<line x1="${X(j.deadline)}" y1="${y + 1}" x2="${X(j.deadline)}" y2="${y + rowH - 3}" stroke="${p.schedule[id]?.late ? 'var(--bad)' : 'var(--ink)'}" opacity=".5"/>`); }
  });
  o.push(`<line x1="${X(sim.time)}" y1="${top - 4}" x2="${X(sim.time)}" y2="${H}" stroke="var(--bad)" stroke-width="1.5"/></svg>`);
  $('gantt').innerHTML = o.join('');
}

// ------------------------------------------------------------------ popover (click in 3D)
let popState = null;
function showPopover(data, at, refresh = false) {
  const pop = $('popover');
  if (!data) return hidePopover();
  popState = { data, at };
  let html = '';
  const p = mode === 'C' ? disp.plan : null;
  if (data.type === 'tractor') {
    const t = sim.tractor(data.id);
    const q = p?.assign[t.id] || [];
    html = `<h3><span class="dot" style="background:${tc(t.id)}"></span>${t.id} ${esc(t.name)} <span class="muted" style="font-weight:400">${esc(t.model || '')}</span></h3>
      <p>${t.status === 'broken' ? `<b style="color:var(--bad)">Out of service</b>${t.fault ? ` — ${esc(t.fault)}` : ''}` : esc(t.action ? `${t.action.kind}${t.action.purpose ? ' · ' + t.action.purpose : ''}` : 'idle')}</p>
      <p class="muted">${Math.round(100 * t.fuel / t.fuelCapacity)}% ${t.model?.includes('Electric') ? 'battery' : 'fuel'} · mounted ${t.mounted} · carries ${t.implements.join(', ')}</p>
      <p>Queue: ${q.length ? q.map(id => `<span class="chip" data-ask="job:${id}">${id} →${fmtTime(p.schedule[id].end)}</span>`).join(' ') : '<span class="muted">none</span>'}</p>`;
    html += `<div class="row"><button class="btn primary" data-ask="tractor:${t.id}">Why?</button>${t.status === 'broken' ? `<button class="btn" data-op="repair" data-t="${t.id}">Repair</button>` : `<button class="btn danger" data-op="breakdown" data-t="${t.id}">Break down</button>`}</div>`;
  } else {
    const f = sim.fields.get(data.id);
    const jobs = [...sim.jobs.values()].filter(j => j.fieldId === f.id);
    html = `<h3>${esc(f.name)} <span class="muted" style="font-weight:400">${f.acres} ac · ${esc(f.crop)}</span></h3>` +
      (jobs.length ? jobs.map(j => { const [lab, cls] = jobState(j); const o = j.status === 'done' ? j.doneBy : owner(j.id); return `<p><b>${j.id}</b> ${JOB_VERB[j.type]} · due ${fmtTime(j.deadline)} · ${o || '—'} <span class="chip ${cls}">${lab}</span> <button class="btn" data-ask="job:${j.id}" style="padding:1px 7px">Why?</button></p>`; }).join('') : '<p class="muted">No jobs on this field.</p>');
  }
  if (refresh && pop.innerHTML === html) return;
  pop.innerHTML = html;
  pop.hidden = false;
  if (!refresh) {
    const x = Math.min(at.x + 14, innerWidth - 320), y = Math.min(at.y + 10, innerHeight - pop.offsetHeight - 16);
    pop.style.left = `${x}px`; pop.style.top = `${Math.max(80, y)}px`;
  }
}
function hidePopover() { popState = null; $('popover').hidden = true; }

// ------------------------------------------------------------------ compare
function compare() {
  const run = D => { const s = new Simulator(scenario, new D(), { scriptedEvents: $('scripted').checked }); for (const e of injected) s.inject(structuredClone(e)); return s.run(); };
  const c = run(Coordinator), b = run(Baseline);
  const rows = [['Jobs completed', 'jobsCompleted', 1], ['…on time', 'jobsOnTime', 1], ['Priority-weighted acres on time', 'priorityValueOnTime', 1], ['Travel (tractor-min)', 'travelMin', -1], ['Idle in working day (tractor-min)', 'idleMin', -1], ['Implement swaps', 'implementSwaps', -1], ['Unannounced violations', 'violations', -1], ['Late jobs flagged in advance', 'lateFlagged', 0]];
  $('cmpBody').innerHTML = `<table><tr><th>Metric</th><th>AI coordinator</th><th>FCFS baseline</th></tr>${rows.map(([l, k, d]) => `<tr><td>${l}</td><td class="num ${d && (c[k] - b[k]) * d > 0 ? 'better' : ''}">${c[k]}</td><td class="num">${b[k]}</td></tr>`).join('')}<tr><td>All work finished</td><td class="num">${c.makespanClock}</td><td class="num">${b.makespanClock}</td></tr></table>`;
  $('cmpNote').textContent = `Same farm, same simulator, ${$('scripted').checked ? 'the scripted events' : 'no scripted events'}${injected.length ? ` plus your ${injected.length} operator action(s)` : ''}.`;
  $('cmpModal').classList.add('open');
}

// ------------------------------------------------------------------ wiring
$('play').onclick = () => setPlaying(!playing);
$('step').onclick = () => { for (let i = 0; i < 10 && !sim.finished; i++) sim.step(); processLog(); uiDirty = true; };
$('speed').onchange = e => { speed = +e.target.value; };
$('reset').onclick = () => { $('settingsPop').open = false; reset(); };
$('resetView').onclick = () => { $('settingsPop').open = false; scene.resetView(); };
$('scripted').onchange = reset;
$('modeC').onclick = () => { mode = 'C'; $('modeC').classList.add('on'); $('modeB').classList.remove('on'); reset(); };
$('modeB').onclick = () => { mode = 'B'; $('modeB').classList.add('on'); $('modeC').classList.remove('on'); reset(); };
$('compare').onclick = compare;
$('cmpClose').onclick = () => $('cmpModal').classList.remove('open');
$('cmpModal').onclick = e => { if (e.target.id === 'cmpModal') $('cmpModal').classList.remove('open'); };
$('timelineDetails').ontoggle = () => uiDirty = true;
$('askFab').onclick = () => { if ($('ask').hidden) openAsk(shifts.length ? `shift:${shifts[shifts.length - 1].id}` : `tractor:T1`); else $('ask').hidden = true; };
$('askClose').onclick = () => { $('ask').hidden = true; };
$('askCtx').onchange = () => refreshAskCtx();
$('askChips').onclick = e => { if (e.target.tagName === 'BUTTON') ask(e.target.textContent); };
$('askForm').onsubmit = e => { e.preventDefault(); const q = $('askInput').value.trim(); if (q) { $('askInput').value = ''; ask(q); } };
$('opBreak').onclick = () => inject({ type: 'breakdown', tractor: $('opTractor').value, signal: 'Operator reported fault' });
$('opRepair').onclick = () => inject({ type: 'repair', tractor: $('opTractor').value });
$('pApply').onclick = () => { const job = $('pJob').value; if (job) inject({ type: 'priority_change', job, priority: $('pPri').value, deadline: toMin($('pDl').value) }); };
$('nAdd').onclick = () => inject({ type: 'new_jobs', jobs: [{ id: `N${newJobSeq++}`, type: $('nType').value, fieldId: $('nField').value, priority: $('nPri').value, deadline: toMin($('nDl').value) }] });
$('bulkAdd').onclick = () => {
  try {
    const list = JSON.parse($('bulk').value);
    if (!Array.isArray(list)) throw new Error('expected a JSON array');
    const jobs = list.map(j => {
      if (!IMPLEMENT_FOR[j.type]) throw new Error(`unknown job type "${j.type}"`);
      if (!sim.fields.has(j.fieldId)) throw new Error(`unknown field "${j.fieldId}"`);
      return { id: j.id && !sim.jobs.has(j.id) ? String(j.id) : `N${newJobSeq++}`, type: j.type, fieldId: j.fieldId, acres: j.acres, priority: j.priority || 'medium', deadline: typeof j.deadline === 'string' ? toMin(j.deadline) : j.deadline };
    });
    inject({ type: 'new_jobs', jobs }); $('bulkMsg').textContent = `Submitted ${jobs.length}.`;
  } catch (e) { $('bulkMsg').textContent = 'Error: ' + e.message; }
};
document.body.addEventListener('click', e => {
  const a = e.target.closest('[data-ask]');
  if (a) { e.stopPropagation(); openAsk(a.dataset.ask, a.dataset.ask.startsWith('job') ? 'Why is this job planned this way?' : 'What is this tractor doing and why?'); return; }
  const op = e.target.closest('[data-op]');
  if (op) {
    const d = op.dataset, br = scenario.map.features?.bridges || [];
    if (d.op === 'breakdown') inject({ type: 'breakdown', tractor: d.t, signal: 'Operator reported fault' });
    if (d.op === 'repair') inject({ type: 'repair', tractor: d.t });
    if (d.op === 'block') inject({ type: 'block_route', name: br[d.b].name, cells: br[d.b].cells, signal: `${br[d.b].name} closed by operator` });
    if (d.op === 'unblock') inject({ type: 'unblock_route', name: br[d.b].name, cells: br[d.b].cells });
    if (d.op === 'approve') inject({ type: 'priority_change', job: d.j, allowLate: true });
    if (d.op === 'drop') inject({ type: 'cancel_job', job: d.j });
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) {
    const [kind, id] = f.dataset.focus.split(':');
    const cell = kind === 'tractor' ? sim.tractor(id) : sim.jobField(sim.jobs.get(id));
    scene.focus(cell);
  }
});
addEventListener('keydown', e => { if (e.key === 'Escape') { hidePopover(); $('ask').hidden = true; } });

// Debug/automation hook: window.fleet.advance(90) runs 90 sim minutes and redraws.
window.fleet = {
  get sim() { return sim; },
  get scene() { return scene; },
  advance(min) { for (let i = 0; i < min && !sim.finished; i++) sim.step(); processLog(); renderUi(); scene.update(sim, mode === 'C' ? disp.plan : null, 0.5); return fmtTime(sim.time); },
  frame(dt = 0.1) { scene.update(sim, mode === 'C' ? disp.plan : null, dt); },
};

boot().catch(err => { $('loading').textContent = `Could not start: ${err.message}`; console.error(err); });
