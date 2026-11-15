// 3D farm view (three.js): fields, creek + bridges, depot, low-poly tractors,
// live routes, planned routes, and re-route animations.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const TCOL = { T1: 0x2f7fd6, T2: 0xe07b1f, T3: 0x8a55c9 };
const CROP = { corn: 0xb8c45e, hay: 0x9fc265, soybeans: 0x6fae5f, orchard: 0x5f9a55, wheat: 0xd9c271, alfalfa: 0x86bb63 };
const WORKED = { spray: 0x3f8f6a, mow: 0xd8cf8a, till: 0x7a5a3c, seed: 0x8b6a45 };
const IMPL = { sprayer: 0x2aa198, mower: 0x9aa0a6, tiller: 0x8b5a2b, seeder: 0xe0b23a };
const tcol = id => TCOL[id] ?? 0x2c6fbb;

export class FarmScene {
  constructor(el, scenario, { onPick } = {}) {
    this.el = el; this.sc = scenario; this.onPick = onPick;
    this.W = scenario.map.width; this.H = scenario.map.height;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    this.dark = dark;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    el.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    const sky = dark ? 0x10171a : 0xcfe3e8;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, 45, 95);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 8; this.controls.maxDistance = 70;
    this.resetView();

    this.scene.add(new THREE.HemisphereLight(dark ? 0x8899aa : 0xffffff, dark ? 0x223322 : 0x8a9a6a, dark ? 0.85 : 0.95));
    const sun = new THREE.DirectionalLight(0xfff4e0, dark ? 0.9 : 1.6);
    sun.position.set(-18, 30, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 22, bottom: -22, near: 1, far: 80 });
    this.scene.add(sun);

    this.tractors = new Map(); this.fields = new Map(); this.bridges = []; this.routes = new Map();
    this.ghosts = []; this.pulses = []; this.plans = new Map(); this.pickables = [];
    this._build();
    this.raycaster = new THREE.Raycaster();
    this.renderer.domElement.addEventListener('click', e => this._pick(e));
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  // grid cell → world
  wx(x) { return x - this.W / 2 + 0.5; }
  wz(y) { return y - this.H / 2 + 0.5; }

  resetView() {
    this.camera.position.set(-2, 25, 25);
    this.controls.target.set(1.5, 0, 1.5);
    this.controls.update();
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  _label(cls, html) {
    const d = document.createElement('div'); d.className = `lbl ${cls}`; d.innerHTML = html;
    return new CSS2DObject(d);
  }

  _rowsTexture(color) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    const col = new THREE.Color(color);
    g.fillStyle = `#${col.getHexString()}`; g.fillRect(0, 0, 64, 64);
    g.fillStyle = `#${col.clone().multiplyScalar(0.78).getHexString()}`;
    for (let i = 0; i < 64; i += 8) g.fillRect(0, i, 64, 3);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _build() {
    const { W, H } = this;
    // ground + margin
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W + 40, H + 40), new THREE.MeshStandardMaterial({ color: this.dark ? 0x37462f : 0xb9c99a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    this.scene.add(ground);
    const farm = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ color: this.dark ? 0x435438 : 0xc9d6a9, roughness: 1 }));
    farm.rotation.x = -Math.PI / 2; farm.position.y = 0.005; farm.receiveShadow = true;
    this.scene.add(farm);

    // creek
    const river = this.sc.map.features?.river;
    if (river) {
      const water = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.06, H + 40), new THREE.MeshStandardMaterial({ color: 0x4f93c6, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.92 }));
      water.position.set(this.wx(river.x), 0.01, 0);
      this.scene.add(water);
      const bankMat = new THREE.MeshStandardMaterial({ color: this.dark ? 0x3d4a33 : 0x9fb27a });
      for (const dx of [-0.62, 0.62]) {
        const bank = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, H + 40), bankMat);
        bank.position.set(this.wx(river.x) + dx, 0.04, 0); this.scene.add(bank);
      }
      const lab = this._label('fd', `${river.label}`); lab.position.set(this.wx(river.x), 0.3, this.wz(9.5)); this.scene.add(lab);
    }
    for (const b of this.sc.map.features?.bridges || []) {
      const [x, y] = b.cells[0];
      const g = new THREE.Group();
      const deck = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.14, 0.9), new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 }));
      deck.position.y = 0.12; deck.castShadow = deck.receiveShadow = true; g.add(deck);
      for (const dz of [-0.42, 0.42]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.05), new THREE.MeshStandardMaterial({ color: 0x5b4630 }));
        rail.position.set(0, 0.28, dz); g.add(rail);
      }
      const barrier = new THREE.Group();
      const red = new THREE.MeshStandardMaterial({ color: 0xd63a2f, emissive: 0x6a0f0a });
      for (const dx of [-0.95, 0.95]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 1.0), red); bar.position.set(dx, 0.45, 0); barrier.add(bar);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.08), red); post.position.set(dx, 0.3, 0); barrier.add(post);
      }
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff2010, emissiveIntensity: 2 }));
      lamp.position.set(0, 0.75, 0); barrier.add(lamp);
      barrier.visible = false; g.add(barrier);
      const lab = this._label('warn', `⛔ ${b.name} closed`); lab.position.set(0, 1.2, 0); lab.visible = false; g.add(lab);
      g.position.set(this.wx(x), 0, this.wz(y));
      this.scene.add(g);
      this.bridges.push({ ...b, x, y, barrier, lamp, lab });
    }

    // depot
    const d = this.sc.depot;
    const depot = new THREE.Group();
    const barn = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.4), new THREE.MeshStandardMaterial({ color: 0xa8432f, roughness: 0.8 }));
    barn.position.y = 0.5; barn.castShadow = barn.receiveShadow = true; depot.add(barn);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1.25, 0.7, 4, 1), new THREE.MeshStandardMaterial({ color: 0x4a4f55 }));
    roof.position.y = 1.35; roof.rotation.y = Math.PI / 4; roof.scale.set(1.05, 1, 0.8); roof.castShadow = true; depot.add(roof);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.9, 16), new THREE.MeshStandardMaterial({ color: 0xe6e6e0, metalness: 0.3, roughness: 0.4 }));
    tank.rotation.z = Math.PI / 2; tank.position.set(0.2, 0.3, 1.1); tank.castShadow = true; depot.add(tank);
    const dl = this._label('fd', 'Depot<small>fuel · implement shed</small>'); dl.position.set(0, 2.0, 0); depot.add(dl);
    depot.position.set(this.wx(d.x) - 1.3, 0, this.wz(d.y));
    this.scene.add(depot);

    // fields
    for (const f of this.sc.fields) {
      const g = new THREE.Group();
      const w = f.w - 0.2, h = f.h - 0.2;
      const tex = this._rowsTexture(CROP[f.crop] ?? 0x9fc265); tex.repeat.set(w / 2, h / 2);
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
      base.position.y = 0.08; base.receiveShadow = true; base.userData = { type: 'field', id: f.id };
      g.add(base); this.pickables.push(base);
      const worked = new THREE.Mesh(new THREE.BoxGeometry(1, 0.03, h - 0.02), new THREE.MeshStandardMaterial({ color: WORKED.spray, roughness: 0.9 }));
      worked.position.y = 0.175; worked.visible = false; worked.receiveShadow = true; g.add(worked);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 0.08, 0.2, h + 0.08)), new THREE.LineBasicMaterial({ color: 0x1f7a4d, transparent: true, opacity: 0 }));
      edge.position.y = 0.1; g.add(edge);
      const lab = this._label('fd', `${f.name}<small>${f.acres} ac · ${f.crop}</small>`); lab.position.set(0, 0.5, -h / 2 + 0.3); g.add(lab);
      g.position.set(this.wx(f.x) + f.w / 2 - 0.5, 0, this.wz(f.y) + f.h / 2 - 0.5);
      this.scene.add(g);
      this.fields.set(f.id, { g, base, worked, edge, w, h, lab });
    }

    // a few trees along the edges for scale
    const trunk = new THREE.MeshStandardMaterial({ color: 0x6b4f35 }), leaf = new THREE.MeshStandardMaterial({ color: this.dark ? 0x2f5a35 : 0x4f8a45, roughness: 0.9 });
    const rnd = mulberry(7);
    for (let i = 0; i < 46; i++) {
      const side = i % 4;
      const x = side < 2 ? -W / 2 - 1 - rnd() * 6 + (side ? W + 2 + rnd() * 6 + 6 : 0) : -W / 2 + rnd() * W;
      const z = side >= 2 ? (side === 2 ? -H / 2 - 1.5 - rnd() * 5 : H / 2 + 1.5 + rnd() * 5) : -H / 2 + rnd() * H;
      const t = new THREE.Group();
      const s = 0.6 + rnd() * 0.7;
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.5, 6), trunk); tr.position.y = 0.25; t.add(tr);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 7), leaf); cone.position.y = 1.0; cone.castShadow = true; t.add(cone);
      t.scale.setScalar(s); t.position.set(x, 0, z); this.scene.add(t);
    }

    // tractors
    for (const t of this.sc.tractors) {
      const m = makeTractor(tcol(t.id));
      m.group.userData = { type: 'tractor', id: t.id };
      m.group.traverse(o => { if (o.isMesh) { o.userData = { type: 'tractor', id: t.id }; this.pickables.push(o); } });
      const lab = this._label('tr', `<i style="background:#${tcol(t.id).toString(16).padStart(6, '0')}"></i>${t.id} ${t.name}`);
      lab.position.set(0, 1.35, 0); m.group.add(lab);
      m.group.position.set(this.wx(this.sc.depot.x), 0, this.wz(this.sc.depot.y));
      this.scene.add(m.group);
      this.tractors.set(t.id, { ...m, lab, pos: m.group.position.clone(), heading: 0, impl: null });
    }
  }

  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    this.onPick?.(hit ? hit.object.userData : null, { x: e.clientX, y: e.clientY });
  }

  _curve(cells, y = 0.32) {
    const pts = cells.map(c => new THREE.Vector3(this.wx(c.x), y, this.wz(c.y)));
    if (pts.length === 1) pts.push(pts[0].clone().add(new THREE.Vector3(0.01, 0, 0)));
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.2);
  }

  _tube(cells, color, opacity = 0.9, radius = 0.075) {
    const curve = this._curve(cells);
    const geo = new THREE.TubeGeometry(curve, Math.max(8, cells.length * 6), radius, 6, false);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, transparent: true, opacity });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.total = geo.index.count;
    return mesh;
  }

  // Ring that expands and fades: draws the eye to where something changed.
  pulse(cell, color = 0xff3b30) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.55, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(this.wx(cell.x), 0.35, this.wz(cell.y));
    this.scene.add(ring);
    this.pulses.push({ ring, t: 0 });
  }

  focus(cell) {
    const target = new THREE.Vector3(this.wx(cell.x), 0, this.wz(cell.y));
    this._fly = { from: this.controls.target.clone(), to: target, t: 0 };
  }

  update(sim, plan, dt) {
    const now = performance.now() / 1000;
    // bridges
    const blocked = new Set(sim.nav.blockedCells().map(c => `${c.x},${c.y}`));
    for (const b of this.bridges) {
      const closed = b.cells.every(([x, y]) => blocked.has(`${x},${y}`));
      b.barrier.visible = closed; b.lab.visible = closed;
      if (closed) b.lamp.material.emissiveIntensity = 1 + Math.sin(now * 6) * 1.2;
    }
    // fields
    for (const [id, F] of this.fields) {
      const jobs = [...sim.jobs.values()].filter(j => j.fieldId === id && j.status !== 'cancelled');
      const active = jobs.find(j => sim.tractors.some(t => t.jobId === j.id && t.action?.kind === 'work'));
      const show = active || jobs.filter(j => j.remaining < j.acres).sort((a, b) => (b.doneAt ?? 1e9) - (a.doneAt ?? 1e9))[0];
      if (show) {
        const p = Math.max(0.001, 1 - show.remaining / show.acres);
        F.worked.visible = true;
        F.worked.material.color.setHex(WORKED[show.type]);
        F.worked.scale.x = F.w * p; F.worked.position.x = -F.w / 2 + (F.w * p) / 2;
      } else F.worked.visible = false;
      const open = jobs.filter(j => j.status !== 'done');
      F.edge.material.opacity = active ? 0.6 + 0.4 * Math.sin(now * 4) : open.length ? 0.25 : 0;
      F.edge.material.color.setHex(active ? 0x1f7a4d : 0x5d6b63);
      F.base.material.opacity = 1;
      const st = jobs.length ? jobs.map(j => `${j.id}${j.status === 'done' ? '✓' : ''}`).join(' ') : '';
      const f = sim.fields.get(id);
      const html = `${f.name}<small>${f.acres} ac · ${f.crop}${st ? ' · ' + st : ''}</small>`;
      if (F.lab.element.innerHTML !== html) F.lab.element.innerHTML = html;
    }
    // tractors
    const counts = {};
    for (const t of sim.tractors) {
      const T = this.tractors.get(t.id);
      const key = `${t.x},${t.y}`; const k = (counts[key] = (counts[key] ?? -1) + 1);
      const target = new THREE.Vector3(this.wx(t.x) + k * 0.35, 0, this.wz(t.y) + k * 0.25);
      const prev = T.group.position.clone();
      T.group.position.lerp(target, 1 - Math.exp(-dt * 10));
      const mv = T.group.position.clone().sub(prev);
      if (mv.lengthSq() > 1e-6) T.heading = Math.atan2(-mv.z, mv.x);
      T.group.rotation.y += angleDiff(T.heading, T.group.rotation.y) * (1 - Math.exp(-dt * 8));
      if (T.impl !== t.mounted) { T.setImpl(t.mounted); T.impl = t.mounted; }
      const kind = t.status === 'broken' ? 'broken' : t.action?.kind;
      T.beacon.material.emissive.setHex(kind === 'broken' ? 0xff2010 : kind === 'work' ? 0x30d070 : kind === 'goto' ? 0xffb020 : kind ? 0x30a0ff : 0x555555);
      T.beacon.material.emissiveIntensity = kind === 'broken' ? 1 + Math.sin(now * 8) * 1.5 : 1.4;
      T.group.position.y = kind === 'work' ? Math.abs(Math.sin(now * 14)) * 0.025 : 0;
      T.body.material.color.setHex(kind === 'broken' ? 0x7a7a7a : tcol(t.id));
      for (const w of T.wheels) if (kind === 'goto' || kind === 'work') w.rotation.x -= dt * 8;
      const status = kind === 'broken' ? '⚠ broken down' : kind === 'work' ? `${sim.jobs.get(t.jobId)?.type}ing ${t.jobId}` : kind === 'goto' ? `→ ${t.action.purpose === 'job' ? t.jobId : 'depot'}` : kind === 'refuel' ? 'refuelling' : kind === 'swap' ? 'swapping implement' : 'idle';
      const html = `<i style="background:#${tcol(t.id).toString(16).padStart(6, '0')}"></i>${t.id} <span style="font-weight:500;opacity:.75">${status}</span>`;
      if (T.lab.element.innerHTML !== html) { T.lab.element.innerHTML = html; T.lab.element.classList.toggle('warn', kind === 'broken'); }

      // live route
      const path = t.action?.kind === 'goto' ? t.action.path : null;
      const R = this.routes.get(t.id);
      const rkey = path?.length ? `${t.action.target.x},${t.action.target.y}|${sim.nav.version}|${path.length}` : null;
      if (R && R.key !== rkey) {
        // Route changed before arrival → keep the abandoned route as a fading red ghost.
        const sameTarget = path && R.target === `${t.action.target.x},${t.action.target.y}` && R.ver === sim.nav.version;
        const arrived = R.target === `${t.x},${t.y}`;
        this.scene.remove(R.mesh);
        if (!sameTarget && !arrived && R.cells.length > 2) {
          const ghost = this._tube(R.cells, 0xff4b3a, 0.85, 0.06);
          this.scene.add(ghost); this.ghosts.push({ mesh: ghost, t: 0 });
          this.pulse({ x: t.x, y: t.y }, 0xffb020);
        }
        R.mesh.geometry.dispose();
        this.routes.delete(t.id);
      }
      if (rkey && (!this.routes.get(t.id))) {
        const cells = [{ x: t.x, y: t.y }, ...path];
        const mesh = this._tube(cells, tcol(t.id));
        mesh.geometry.setDrawRange(0, 0);
        this.scene.add(mesh);
        this.routes.set(t.id, { key: rkey, mesh, cells, draw: 0, target: `${t.action.target.x},${t.action.target.y}`, ver: sim.nav.version });
      }
      const live = this.routes.get(t.id);
      if (live && live.draw < 1) { live.draw = Math.min(1, live.draw + dt * 2.2); live.mesh.geometry.setDrawRange(0, Math.floor(live.mesh.userData.total * live.draw / 3) * 3); }
    }
    // planned future routes (light dashed lines through each queue)
    const pkey = plan ? `${plan.time}|${sim.nav.version}|${Object.values(plan.assign).flat().join(',')}` : 'none';
    if (pkey !== this._pkey) {
      this._pkey = pkey;
      for (const l of this.plans.values()) { this.scene.remove(l); l.geometry.dispose(); }
      this.plans.clear();
      if (plan) for (const t of sim.tractors) {
        if (t.status !== 'ok') continue;
        const ids = (plan.assign[t.id] || []).filter(id => sim.jobs.get(id)?.status !== 'done');
        let cur = t.action?.kind === 'goto' ? t.action.target : { x: t.x, y: t.y };
        const cells = [];
        for (const id of ids.slice(t.action?.kind === 'goto' && t.action.purpose === 'job' ? 1 : 0)) {
          const to = sim.jobField(sim.jobs.get(id));
          const p = sim.nav.path(cur, to);
          if (p) { if (!cells.length) cells.push(cur); cells.push(...p); cur = to; }
        }
        if (cells.length < 2) continue;
        const pts = cells.map(c => new THREE.Vector3(this.wx(c.x), 0.24, this.wz(c.y)));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: tcol(t.id), dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.55 }));
        line.computeLineDistances();
        this.scene.add(line); this.plans.set(t.id, line);
      }
    }
    // ghosts & pulses
    this.ghosts = this.ghosts.filter(g => {
      g.t += dt; g.mesh.material.opacity = Math.max(0, 0.85 * (1 - g.t / 3.5));
      g.mesh.position.y = g.t * 0.08;
      if (g.t > 3.5) { this.scene.remove(g.mesh); g.mesh.geometry.dispose(); return false; }
      return true;
    });
    this.pulses = this.pulses.filter(p => {
      p.t += dt; const s = 1 + p.t * 3.2; p.ring.scale.set(s, s, s); p.ring.material.opacity = Math.max(0, 0.9 * (1 - p.t / 1.6));
      if (p.t > 1.6) { this.scene.remove(p.ring); return false; }
      return true;
    });
    if (this._fly) {
      this._fly.t = Math.min(1, this._fly.t + dt * 1.6);
      const e = 1 - Math.pow(1 - this._fly.t, 3);
      const nt = this._fly.from.clone().lerp(this._fly.to, e);
      this.camera.position.add(nt.clone().sub(this.controls.target)); this.controls.target.copy(nt);
      if (this._fly.t >= 1) this._fly = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

function makeTractor(color) {
  const group = new THREE.Group();
  const s = 0.62;
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xbfe3f2, transparent: true, opacity: 0.55, roughness: 0.1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0 * s, 0.34 * s, 0.52 * s), paint);
  body.position.set(0.05 * s, 0.42 * s, 0);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.55 * s, 0.3 * s, 0.42 * s), paint);
  hood.position.set(0.45 * s, 0.6 * s, 0);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.46 * s, 0.5 * s, 0.5 * s), glass);
  cab.position.set(-0.18 * s, 0.84 * s, 0);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(0.54 * s, 0.06 * s, 0.56 * s), paint);
  roof.position.set(-0.18 * s, 1.12 * s, 0);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * s, 0.03 * s, 0.35 * s, 8), dark);
  stack.position.set(0.55 * s, 0.9 * s, 0.12 * s);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.07 * s, 10, 10), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x30d070, emissiveIntensity: 1.4 }));
  beacon.position.set(-0.18 * s, 1.2 * s, 0);
  const wheels = [];
  for (const [x, z, r, w] of [[-0.3, 0.33, 0.34, 0.18], [-0.3, -0.33, 0.34, 0.18], [0.5, 0.28, 0.2, 0.12], [0.5, -0.28, 0.2, 0.12]]) {
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(r * s, r * s, w * s, 18), dark);
    wh.rotation.x = Math.PI / 2; wh.position.set(x * s, r * s, z * s);
    const holder = new THREE.Group(); holder.add(wh); wheels.push(wh);
    group.add(holder);
  }
  const implGroup = new THREE.Group(); implGroup.position.set(-0.72 * s, 0.25 * s, 0);
  for (const m of [body, hood, cab, roof, stack, beacon]) { m.castShadow = true; group.add(m); }
  group.add(implGroup);
  const setImpl = impl => {
    implGroup.clear();
    const mat = new THREE.MeshStandardMaterial({ color: IMPL[impl] ?? 0x888888, roughness: 0.6 });
    if (impl === 'sprayer') {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.16 * s, 0.4 * s, 14), mat); tank.rotation.z = Math.PI / 2; tank.position.y = 0.12 * s;
      const boom = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.04 * s, 1.9 * s), new THREE.MeshStandardMaterial({ color: 0x555b60 })); boom.position.set(-0.2 * s, 0.05 * s, 0);
      implGroup.add(tank, boom);
    } else if (impl === 'mower') {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.1 * s, 1.1 * s), mat); deck.position.y = -0.1 * s; implGroup.add(deck);
    } else if (impl === 'tiller') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.22 * s, 0.14 * s, 1.0 * s), mat); bar.position.y = -0.06 * s;
      implGroup.add(bar);
      for (let i = -2; i <= 2; i++) { const tine = new THREE.Mesh(new THREE.BoxGeometry(0.04 * s, 0.18 * s, 0.04 * s), mat); tine.position.set(-0.06 * s, -0.18 * s, i * 0.2 * s); implGroup.add(tine); }
    } else if (impl === 'seeder') {
      const hop = new THREE.Mesh(new THREE.BoxGeometry(0.32 * s, 0.26 * s, 1.0 * s), mat); hop.position.y = 0.06 * s; implGroup.add(hop);
    }
    implGroup.traverse(o => { if (o.isMesh) o.castShadow = true; });
  };
  return { group, body, beacon, wheels, setImpl };
}

function angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
