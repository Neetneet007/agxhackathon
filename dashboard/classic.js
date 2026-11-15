// Fleet Command Center — runs the real coordinator (or the baseline) live in the browser.
import { Simulator } from '../src/simulator.js';
import { Coordinator } from '../src/coordinator.js';
import { Baseline } from '../src/baseline.js';
import { fmtTime, JOB_VERB, IMPLEMENT_FOR, START_HOUR } from '../src/model.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = { T1: 'var(--t1)', T2: 'var(--t2)', T3: 'var(--t3)' };
const tcolor = id => COLORS[id] || 'var(--info)';
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m - START_HOUR * 60; };

let scenario, sim, disp, mode = 'C', playing = false, speed = 15, acc = 0, lastTs = 0, selected = null;
let injected = [], newJobSeq = 1, lastLogLen = -1, dirty = true;

async function boot() {
  scenario = await (await fetch('../scenario.json')).json();
  $('scenarioName').textContent = scenario.name;
  $('nField').innerHTML = scenario.fields.map(f => `<option value="${f.id}">${f.id} ${esc(f.name)}</option>`).join('');
  reset();
  requestAnimationFrame(loop);
}

function reset() {
  disp = mode === 'C' ? new Coordinator() : new Baseline();
  sim = new Simulator(scenario, disp, { scriptedEvents: $('scripted').checked });
  injected = []; selected = null; lastLogLen = -1; acc = 0; dirty = true;
  setPlaying(false);
  render(true);
}

function setPlaying(p) { playing = p && !sim.finished; $('play').textContent = playing ? '❚❚ Pause' : '▶ Run'; }

function inject(evt) {
  const e = { ...evt, time: sim.time };
  injected.push(e);
  sim.inject(e);
  sim.processEvents();
  dirty = true; render(true);
}

function loop(ts) {
  const dt = lastTs ? Math.min(ts - lastTs, 250) : 0; lastTs = ts;
  if (playing) {
    acc += dt * speed / 1000;
    while (acc >= 1 && !sim.finished) { sim.step(); acc -= 1; dirty = true; }
    if (sim.finished) setPlaying(false);
  }
  if (dirty) { render(); dirty = false; }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- render
let lastFull = 0;
function render(force = false) {
  const now = performance.now();
  if (!force && now - lastFull < 90) { dirty = true; return; }
  lastFull = now;
  $('clock').textContent = fmtTime(sim.time) + (sim.finished ? ' · done' : '');
  renderKpis(); renderMap(); renderTractors(); renderOps(); renderGantt(); renderJobs(); renderWhy(); renderLog();
}

function plan() { return mode === 'C' ? disp.plan : null; }

function jobState(j) {
  const p = plan();
  const worker = sim.tractors.find(t => t.jobId === j.id && t.status === 'ok');
  if (j.status === 'cancelled') return { label: 'Dropped', cls: 'bad' };
  if (j.status === 'done') return j.doneAt > j.deadline ? { label: `Done ${j.doneAt - j.deadline}m late`, cls: 'late' } : { label: 'Done', cls: 'done' };
  if (worker?.action?.kind === 'work') return { label: 'Working', cls: '' , tractor: worker.id };
  if (p) {
    if (p.unassigned.some(u => u.id === j.id)) return { label: 'Does not fit today', cls: 'bad' };
    const l = p.late.find(x => x.id === j.id);
    if (l) return { label: l.approved ? 'Late (approved)' : 'Late — needs OK', cls: 'late' };
  }
  if (worker) return { label: worker.action?.kind === 'goto' ? 'En route' : worker.action?.kind === 'refuel' ? 'Refuel first' : worker.action?.kind === 'swap' ? 'Swapping implement' : 'Assigned', cls: '' };
  return { label: 'Queued', cls: '' };
}

function ownerOf(id) {
  const p = plan();
  if (p) return Object.keys(p.assign).find(t => p.assign[t].includes(id)) || null;
  return sim.tractors.find(t => t.jobId === id)?.id || null;
}

function renderKpis() {
  const jobs = [...sim.jobs.values()];
  const done = jobs.filter(j => j.status === 'done');
  const onTime = done.filter(j => j.doneAt <= j.deadline).length;
  const st = k => sim.tractors.reduce((a, t) => a + t.stats[k], 0);
  // idle inside each tractor's working day (minutes after its last task are spare capacity)
  const idle = sim.tractors.reduce((a, t) => a + (t.idleTicks || []).filter(x => x < (t.stats.lastActive ?? -1)).length + t.stats.wait, 0);
  const viol = sim.violations.filter(v => !['unfinished', 'deadline-flagged'].includes(v.kind)).length;
  const p = plan();
  const flagged = p ? p.late.filter(l => !l.approved).length + p.unassigned.length : '—';
  const k = (v, l, cls = '') => `<div class="kpi"><b class="${cls}">${v}</b><span>${l}</span></div>`;
  $('kpis').innerHTML = k(`${done.length}/${jobs.filter(j => j.status !== 'cancelled').length}`, 'jobs done') + k(onTime, 'on time') +
    k(flagged, 'need operator', flagged ? 'worse' : '') + k(st('travel'), 'travel min') + k(idle, 'idle min') +
    k(viol, 'violations', viol ? 'worse' : 'better') + (p ? k(fmtTime(p.finish), 'plan finish') : '');
}

// ---------------------------------------------------------------- map
const C = 22;
function renderMap() {
  const W = scenario.map.width, H = scenario.map.height;
  const parts = [`<svg viewBox="0 0 ${W * C} ${H * C}" role="img" aria-label="Farm map">`];
  parts.push(`<rect width="${W * C}" height="${H * C}" fill="var(--panel)"/>`);
  for (let x = 0; x <= W; x++) parts.push(`<line x1="${x * C}" y1="0" x2="${x * C}" y2="${H * C}" stroke="var(--grid)"/>`);
  for (let y = 0; y <= H; y++) parts.push(`<line x1="0" y1="${y * C}" x2="${W * C}" y2="${y * C}" stroke="var(--grid)"/>`);
  for (const [x, y] of scenario.map.obstacles) parts.push(`<rect x="${x * C}" y="${y * C}" width="${C}" height="${C}" fill="var(--river)"/>`);
  const river = scenario.map.features?.river;
  if (river) parts.push(`<text x="${river.x * C + C / 2}" y="${9.5 * C}" font-size="10" fill="var(--info)" text-anchor="middle" transform="rotate(-90 ${river.x * C + C / 2} ${9.5 * C})">${esc(river.label)}</text>`);
  const blocked = new Set(sim.nav.blockedCells().map(c => `${c.x},${c.y}`));
  for (const b of scenario.map.features?.bridges || []) for (const [x, y] of b.cells) {
    parts.push(`<rect x="${x * C}" y="${y * C + 4}" width="${C}" height="${C - 8}" fill="var(--bridge)" rx="2"/>`);
    if (blocked.has(`${x},${y}`)) parts.push(`<path d="M${x * C + 3} ${y * C + 3} L${x * C + C - 3} ${y * C + C - 3} M${x * C + C - 3} ${y * C + 3} L${x * C + 3} ${y * C + C - 3}" stroke="var(--bad)" stroke-width="3"/>`);
  }
  // fields
  for (const f of sim.fields.values()) {
    const jobs = [...sim.jobs.values()].filter(j => j.fieldId === f.id && j.status !== 'cancelled');
    const open = jobs.filter(j => j.status !== 'done');
    const working = sim.tractors.some(t => t.action?.kind === 'work' && sim.jobs.get(t.jobId)?.fieldId === f.id);
    const stroke = working ? 'var(--accent)' : open.length ? 'var(--muted)' : 'var(--line)';
    parts.push(`<rect x="${f.x * C + 1}" y="${f.y * C + 1}" width="${f.w * C - 2}" height="${f.h * C - 2}" rx="4" fill="var(--field)" stroke="${stroke}" stroke-width="${working ? 2.5 : 1}" ${open.length ? '' : 'opacity=".55"'}/>`);
    parts.push(`<text x="${f.x * C + 5}" y="${f.y * C + 13}" font-size="10.5" font-weight="600" fill="var(--ink)">${f.id} ${esc(f.name)}</text>`);
    parts.push(`<text x="${f.x * C + 5}" y="${f.y * C + 25}" font-size="9.5" fill="var(--muted)">${f.acres} ac · ${esc(f.crop || '')}</text>`);
    jobs.forEach((j, i) => {
      const pct = 1 - j.remaining / j.acres;
      const x = f.x * C + 5 + i * 46, y = f.y * C + f.h * C - 16;
      parts.push(`<g style="cursor:pointer" data-job="${j.id}"><rect x="${x}" y="${y}" width="42" height="12" rx="3" fill="var(--soft)" stroke="${j.status === 'done' ? 'var(--good)' : 'var(--line)'}"/><rect x="${x}" y="${y}" width="${42 * pct}" height="12" rx="3" fill="var(--good)" opacity=".35"/><text x="${x + 21}" y="${y + 9}" font-size="8.5" text-anchor="middle" fill="var(--ink)">${j.id} ${JOB_VERB[j.type].toLowerCase()}</text></g>`);
    });
  }
  // depot
  const d = sim.depot;
  parts.push(`<rect x="${d.x * C - 4}" y="${d.y * C - 4}" width="${C + 8}" height="${C + 8}" rx="4" fill="var(--ink)"/><text x="${d.x * C + C / 2}" y="${d.y * C + C / 2 + 4}" font-size="10" text-anchor="middle" fill="var(--panel)" font-weight="700">D</text><text x="${d.x * C + C / 2}" y="${d.y * C + C + 16}" font-size="9.5" text-anchor="middle" fill="var(--muted)">Depot</text>`);
  // routes & tractors
  for (const t of sim.tractors) {
    if (t.trail.length > 1) parts.push(`<polyline points="${t.trail.map(([x, y]) => `${x * C + C / 2},${y * C + C / 2}`).join(' ')}" fill="none" stroke="${tcolor(t.id)}" stroke-width="2" opacity=".25"/>`);
    if (t.action?.kind === 'goto' && t.action.path?.length) {
      const pts = [[t.x, t.y], ...t.action.path.map(c => [c.x, c.y])];
      parts.push(`<polyline points="${pts.map(([x, y]) => `${x * C + C / 2},${y * C + C / 2}`).join(' ')}" fill="none" stroke="${tcolor(t.id)}" stroke-width="2" stroke-dasharray="4 4"/>`);
    }
  }
  const offs = { T1: [-5, -5], T2: [5, -5], T3: [0, 5] };
  for (const t of sim.tractors) {
    const [ox, oy] = offs[t.id] || [0, 0];
    const cx = t.x * C + C / 2 + ox, cy = t.y * C + C / 2 + oy;
    parts.push(`<g><circle cx="${cx}" cy="${cy}" r="9" fill="${t.status === 'broken' ? 'var(--panel)' : tcolor(t.id)}" stroke="${t.status === 'broken' ? 'var(--bad)' : 'var(--panel)'}" stroke-width="2"/><text x="${cx}" y="${cy + 3.5}" font-size="9" font-weight="700" text-anchor="middle" fill="${t.status === 'broken' ? 'var(--bad)' : '#fff'}">${t.id}</text>${t.status === 'broken' ? `<text x="${cx + 11}" y="${cy - 8}" font-size="12">⚠</text>` : ''}</g>`);
  }
  parts.push('</svg>');
  $('mapSvg').innerHTML = parts.join('');
}

// ---------------------------------------------------------------- tractors
function actionText(t) {
  if (t.status === 'broken') return '<span class="worse">Out of service</span>';
  const a = t.action, j = t.jobId ? sim.jobs.get(t.jobId) : null;
  if (!a) return j ? `Starting ${esc(sim.label(j))}` : 'Idle';
  if (a.kind === 'goto') return a.purpose === 'job' ? `Driving to ${esc(sim.fields.get(j.fieldId).name)} for ${j.id}` : a.purpose === 'refuel' ? 'Heading to depot to refuel' : 'Heading to depot to swap implement';
  if (a.kind === 'work') return `${JOB_VERB[j.type]}ing ${esc(sim.fields.get(j.fieldId).name)} (${j.id}) · ${(100 * (1 - j.remaining / j.acres)).toFixed(0)}%`;
  if (a.kind === 'refuel') return `Refuelling · ${a.left} min left`;
  if (a.kind === 'swap') return `Fitting ${a.impl} · ${a.left} min left`;
  return a.kind;
}

function renderTractors() {
  const p = plan();
  $('tractors').innerHTML = sim.tractors.map(t => {
    const pct = 100 * t.fuel / t.fuelCapacity;
    const q = p ? (p.assign[t.id] || []) : (t.jobId ? [t.jobId] : []);
    const lateSet = new Set(p ? p.late.map(l => l.id) : []);
    return `<div class="tcard" style="--c:${tcolor(t.id)}">
      <div class="top"><span class="name">${t.id} ${esc(t.name)} <span class="muted" style="font-weight:400">· ${esc(t.model || '')}</span></span><span class="state">${t.mounted}${t.implements.length > 1 ? ` <span class="muted">(+${t.implements.filter(i => i !== t.mounted).join(', ')})</span>` : ''}</span></div>
      <div>${actionText(t)}</div>
      <div class="bar ${pct < 25 ? 'low' : ''}" title="${t.model?.includes('Electric') ? 'Battery' : 'Fuel'} ${pct.toFixed(0)}%"><i style="width:${pct}%"></i></div>
      <div class="queue"><span class="muted">${t.model?.includes('Electric') ? 'battery' : 'fuel'} ${pct.toFixed(0)}% · ${p ? 'queue:' : 'current:'}</span>${q.map(id => `<span class="chip ${lateSet.has(id) ? 'late' : ''}" data-job="${id}">${id} ${p?.schedule[id] ? '→' + fmtTime(p.schedule[id].end) : ''}</span>`).join('') || '<span class="muted">—</span>'}</div>
    </div>`;
  }).join('');
}

function renderOps() {
  $('opsTractors').innerHTML = sim.tractors.map(t => t.status === 'broken'
    ? `<button data-op="repair" data-t="${t.id}">Repair ${t.id}</button>`
    : `<button class="danger" data-op="breakdown" data-t="${t.id}">Break ${t.id}</button>`).join('');
  const blocked = new Set(sim.nav.blockedCells().map(c => `${c.x},${c.y}`));
  $('opsRoutes').innerHTML = (scenario.map.features?.bridges || []).map((b, i) => {
    const closed = b.cells.every(([x, y]) => blocked.has(`${x},${y}`));
    return `<button ${closed ? '' : 'class="danger"'} data-op="${closed ? 'unblock' : 'block'}" data-b="${i}">${closed ? 'Reopen' : 'Close'} ${esc(b.name)}</button>`;
  }).join('');
  const open = sim.openJobs();
  const cur = $('pJob').value;
  const html = open.map(j => `<option value="${j.id}">${esc(sim.label(j))} (${j.priority}, ${fmtTime(j.deadline)})</option>`).join('');
  if ($('pJob').dataset.h !== html) { $('pJob').innerHTML = html; $('pJob').dataset.h = html; if (open.some(j => j.id === cur)) $('pJob').value = cur; }
  for (const id of ['step', 'play']) $(id).disabled = sim.finished;
}

// ---------------------------------------------------------------- gantt
function renderGantt() {
  const L = 92, R = 1000, rowH = 30, top = 22, span = sim.horizon;
  const X = t => L + (Math.max(0, Math.min(span, t)) / span) * (R - L);
  const H = top + sim.tractors.length * rowH + 6;
  const out = [`<svg viewBox="0 0 ${R + 10} ${H}">`];
  for (let h = 0; h <= span; h += 60) {
    out.push(`<line x1="${X(h)}" y1="${top - 4}" x2="${X(h)}" y2="${H}" stroke="var(--grid)"/><text x="${X(h)}" y="12" font-size="10" text-anchor="middle" fill="var(--muted)">${fmtTime(h)}</text>`);
  }
  const fill = (kind, tid) => ({ work: tcolor(tid), travel: 'var(--travel)', refuel: 'var(--refuel)', swap: 'var(--swap)', broken: 'var(--broken)', wait: 'var(--warn)' }[kind]);
  const p = plan();
  sim.tractors.forEach((t, i) => {
    const y = top + i * rowH;
    out.push(`<text x="4" y="${y + 17}" font-size="11" font-weight="600" fill="${tcolor(t.id)}">${t.id} ${esc(t.name)}</text>`);
    out.push(`<rect x="${L}" y="${y + 3}" width="${R - L}" height="${rowH - 8}" fill="var(--soft)" rx="3"/>`);
    for (const s of t.history || []) {
      const f = fill(s.kind, t.id); if (!f) continue;
      const w = X(s.end) - X(s.start);
      out.push(`<rect x="${X(s.start)}" y="${y + 3}" width="${Math.max(w, 0.5)}" height="${rowH - 8}" fill="${f}"><title>${s.kind}${s.jobId ? ' ' + s.jobId : ''} ${fmtTime(s.start)}–${fmtTime(s.end)}</title></rect>`);
      if (s.kind === 'work' && w > 26) out.push(`<text x="${X(s.start) + w / 2}" y="${y + 17}" font-size="9.5" fill="#fff" text-anchor="middle">${s.jobId}</text>`);
    }
    if (p && t.status === 'ok') {
      for (const l of p.evals[t.id]?.legs || []) {
        const s0 = Math.max(l.start, sim.time); if (l.end <= s0) continue;
        const f = fill(l.kind === 'travel-depot' ? 'travel' : l.kind, t.id); if (!f) continue;
        const w = X(l.end) - X(s0);
        out.push(`<rect x="${X(s0)}" y="${y + 6}" width="${Math.max(w, 0.5)}" height="${rowH - 14}" fill="${f}" opacity=".38"><title>planned ${l.kind}${l.jobId ? ' ' + l.jobId : ''} ${fmtTime(l.start)}–${fmtTime(l.end)}</title></rect>`);
        if (l.kind === 'work' && w > 26) out.push(`<text x="${X(s0) + w / 2}" y="${y + 17}" font-size="9.5" fill="var(--ink)" text-anchor="middle">${l.jobId}</text>`);
      }
      for (const id of p.assign[t.id] || []) {
        const j = sim.jobs.get(id);
        if (j.deadline <= span) out.push(`<line x1="${X(j.deadline)}" y1="${y + 2}" x2="${X(j.deadline)}" y2="${y + rowH - 4}" stroke="${p.schedule[id]?.late ? 'var(--bad)' : 'var(--ink)'}" stroke-width="1.2" opacity=".55"><title>${id} deadline ${fmtTime(j.deadline)}</title></line>`);
      }
    }
  });
  out.push(`<line x1="${X(sim.time)}" y1="${top - 6}" x2="${X(sim.time)}" y2="${H}" stroke="var(--bad)" stroke-width="1.5"/>`);
  out.push('</svg>');
  $('ganttSvg').innerHTML = out.join('');
}

// ---------------------------------------------------------------- jobs + why
function renderJobs() {
  const p = plan();
  const alerts = [];
  if (p) {
    for (const l of p.late.filter(l => !l.approved)) {
      const j = sim.jobs.get(l.id);
      alerts.push(`<div class="row"><b>${esc(sim.label(j))}</b> can't make ${fmtTime(j.deadline)} — best: ${l.tractor} by ${fmtTime(l.end)} (${Math.round(l.lateness)} min late). <button data-op="approve" data-j="${l.id}">Approve late</button><button class="danger" data-op="drop" data-j="${l.id}">Drop job</button><button data-op="why" data-j="${l.id}">Why?</button></div>`);
    }
    for (const u of p.unassigned) {
      const j = sim.jobs.get(u.id);
      alerts.push(`<div class="row"><b>${esc(sim.label(j))}</b> does not fit in today's shift. <button class="danger" data-op="drop" data-j="${u.id}">Drop job</button><button data-op="why" data-j="${u.id}">Why?</button></div>`);
    }
  }
  $('alerts').innerHTML = alerts.length ? `<div class="alert"><b>Needs operator decision</b>${alerts.join('')}</div>` : '';
  const rows = [...sim.jobs.values()].map(j => {
    const st = jobState(j);
    const owner = j.status === 'done' ? j.doneBy : ownerOf(j.id) || st.tractor || '—';
    const fin = j.status === 'done' ? fmtTime(j.doneAt) : p?.schedule[j.id] ? fmtTime(p.schedule[j.id].end) : '—';
    const pct = 100 * (1 - j.remaining / j.acres);
    return `<tr data-job="${j.id}" class="${selected === j.id ? 'sel' : ''}">
      <td><b>${j.id}</b></td><td>${JOB_VERB[j.type]}</td><td>${esc(sim.fields.get(j.fieldId).name)}</td>
      <td>${j.priority}</td><td class="num">${fmtTime(j.deadline)}</td>
      <td style="color:${owner !== '—' ? tcolor(owner) : 'inherit'};font-weight:600">${owner}</td><td class="num">${fin}</td>
      <td><div class="bar prog"><i style="width:${pct}%"></i></div></td><td><span class="chip ${st.cls}">${st.label}</span></td></tr>`;
  }).join('');
  $('jobs').innerHTML = rows;
}

function renderWhy() {
  if (!selected) return;
  const j = sim.jobs.get(selected);
  if (!j) return;
  let lines;
  if (mode !== 'C') lines = [`The FCFS baseline has no reasoning to show: it gives each free tractor the earliest-submitted job it has an implement for.`];
  else if (j.status === 'cancelled') lines = [`${sim.label(j)} was dropped by the operator.`];
  else lines = disp.why(sim, selected);
  const actions = mode === 'C' && j.status !== 'done' && j.status !== 'cancelled'
    ? `<div class="acts"><button data-op="drop" data-j="${j.id}" class="danger">Drop job</button>${disp.plan.late.some(l => l.id === j.id && !l.approved) ? `<button data-op="approve" data-j="${j.id}">Approve late finish</button>` : ''}</div>` : '';
  $('why').innerHTML = `<h2>Why? — ${esc(sim.label(j))}</h2>${lines.map(l => `<p>${esc(l)}</p>`).join('')}${actions}`;
}

function renderLog() {
  if (sim.log.length === lastLogLen) return;
  lastLogLen = sim.log.length;
  $('log').innerHTML = sim.log.slice().reverse().map(e => `<div class="entry ${e.type}">
    <span class="t">${e.clock}</span>${e.type === 'plan' ? '<b>Re-plan:</b> ' : ''}${esc(e.text)}
    ${e.lines?.length ? `<ul>${e.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
    ${e.footer ? `<div class="foot">${esc(e.footer)}${e.planMs != null ? ` · computed in ${e.planMs} ms` : ''}</div>` : ''}</div>`).join('');
}

// ---------------------------------------------------------------- comparison
function compare() {
  const run = D => {
    const s = new Simulator(scenario, new D(), { scriptedEvents: $('scripted').checked });
    for (const e of injected) s.inject(structuredClone(e));
    return s.run();
  };
  const c = run(Coordinator), b = run(Baseline);
  const rows = [
    ['Jobs completed', 'jobsCompleted', 1], ['…on time', 'jobsOnTime', 1], ['…late', 'jobsLate', -1],
    ['Priority-weighted acres on time', 'priorityValueOnTime', 1], ['Travel (tractor-min)', 'travelMin', -1],
    ['Idle in working day (tractor-min)', 'idleMin', -1], ['Travel + idle (tractor-min)', 'nonProductiveMin', -1],
    ['Refuel stops', 'fuelStops', -1], ['Implement swaps', 'implementSwaps', -1],
    ['Unannounced violations', 'violations', -1], ['Late jobs flagged in advance', 'lateFlagged', 0],
  ];
  const cell = (v, o, dir) => { const cls = dir === 0 || v === o ? '' : (v - o) * dir > 0 ? 'better' : 'worse'; return `<td class="num ${cls}">${v}</td>`; };
  $('cmpBody').innerHTML = `<table><thead><tr><th>Metric</th><th>AI coordinator</th><th>FCFS baseline</th></tr></thead><tbody>${rows.map(([l, k, d]) => `<tr><td>${l}</td>${cell(c[k], b[k], d)}<td class="num">${b[k]}</td></tr>`).join('')}<tr><td>All work finished at</td><td class="num">${c.makespanClock}</td><td class="num">${b.makespanClock}</td></tr></tbody></table>`;
  $('cmpNote').textContent = `Both dispatchers run the same farm, the same simulator and ${$('scripted').checked ? 'the scripted events' : 'no scripted events'}${injected.length ? ` plus your ${injected.length} operator action(s)` : ''}, to the end of the shift.`;
  $('cmpModal').classList.add('open');
}

// ---------------------------------------------------------------- wiring
$('play').onclick = () => setPlaying(!playing);
$('step').onclick = () => { for (let i = 0; i < 10 && !sim.finished; i++) sim.step(); render(true); };
$('speed').onchange = e => { speed = +e.target.value; };
$('reset').onclick = reset;
$('scripted').onchange = reset;
$('modeC').onclick = () => { mode = 'C'; $('modeC').classList.add('on'); $('modeB').classList.remove('on'); reset(); };
$('modeB').onclick = () => { mode = 'B'; $('modeB').classList.add('on'); $('modeC').classList.remove('on'); reset(); };
$('compare').onclick = compare;
$('cmpClose').onclick = () => $('cmpModal').classList.remove('open');
$('cmpModal').onclick = e => { if (e.target.id === 'cmpModal') $('cmpModal').classList.remove('open'); };
$('pApply').onclick = () => { const job = $('pJob').value; if (job) inject({ type: 'priority_change', job, priority: $('pPri').value, deadline: toMin($('pDl').value), note: 'operator change' }); };
$('nAdd').onclick = () => {
  const id = `N${newJobSeq++}`;
  inject({ type: 'new_jobs', jobs: [{ id, type: $('nType').value, fieldId: $('nField').value, priority: $('nPri').value, deadline: toMin($('nDl').value) }] });
};
$('bulkAdd').onclick = () => {
  try {
    const list = JSON.parse($('bulk').value);
    if (!Array.isArray(list)) throw new Error('expected a JSON array of jobs');
    const jobs = list.map(j => {
      if (!IMPLEMENT_FOR[j.type]) throw new Error(`unknown job type "${j.type}"`);
      if (!sim.fields.has(j.fieldId)) throw new Error(`unknown field "${j.fieldId}"`);
      const deadline = typeof j.deadline === 'string' ? toMin(j.deadline) : j.deadline;
      return { id: j.id && !sim.jobs.has(j.id) ? String(j.id) : `N${newJobSeq++}`, type: j.type, fieldId: j.fieldId, acres: j.acres, priority: j.priority || 'medium', deadline };
    });
    inject({ type: 'new_jobs', jobs });
    $('bulkMsg').textContent = `Submitted ${jobs.length} job(s).`;
  } catch (e) { $('bulkMsg').textContent = 'Error: ' + e.message; }
};
document.body.addEventListener('click', e => {
  const op = e.target.closest('[data-op]');
  if (op) {
    const d = op.dataset;
    const bridges = scenario.map.features?.bridges || [];
    if (d.op === 'breakdown') inject({ type: 'breakdown', tractor: d.t, note: 'reported by operator' });
    if (d.op === 'repair') inject({ type: 'repair', tractor: d.t });
    if (d.op === 'block') inject({ type: 'block_route', name: bridges[d.b].name, cells: bridges[d.b].cells, note: 'closed by operator' });
    if (d.op === 'unblock') inject({ type: 'unblock_route', name: bridges[d.b].name, cells: bridges[d.b].cells });
    if (d.op === 'approve') inject({ type: 'priority_change', job: d.j, allowLate: true, note: 'operator approved late finish' });
    if (d.op === 'drop') inject({ type: 'cancel_job', job: d.j });
    if (d.op === 'why') { selected = d.j; render(true); }
    return;
  }
  const jobEl = e.target.closest('[data-job]');
  if (jobEl) { selected = jobEl.dataset.job; render(true); }
});

boot();
