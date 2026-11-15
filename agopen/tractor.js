// One AgOpenWeb instance = one tractor. This client takes the operator seat over the app's own
// WebSocket (the same one its browser page uses), reads live state, and sends commands.
// Frame layouts follow Shared/AgOpenWeb.RemoteServer/wwwroot/transport.js in the AgOpenWeb repo.
import WebSocket from 'ws';

const TYPE = { SCENE: 1, TICK: 2, STATUS: 5 };

export class Tractor {
  constructor(id, port, host = 'localhost') {
    this.id = id; this.port = port; this.url = `ws://${host}:${port}/ws`;
    this.state = { connected: false, frames: 0 };
    this.sent = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      ws.on('open', () => {
        this.state.connected = true;
        this.send(`control.acquire|Fleet-${this.id}`);
        // The app revokes control (and stops steering) if the operator is silent for 1.5 s.
        this.beat = setInterval(() => this.send('control.presence', true), 500);
        // AgOpenWeb takes control away if it misses our heartbeat for 1.5 s, which happens when it is briefly
        // busy (starting a job, loading a tool profile). Asking again is harmless when we still hold it.
        this.claim = setInterval(() => this.send(`control.acquire|Fleet-${this.id}`, true), 2000);
        resolve(this);
      });
      ws.on('message', (data, isBinary) => { if (isBinary) this.decode(data); });
      ws.on('close', () => { this.state.connected = false; clearInterval(this.beat); clearInterval(this.claim); });
      ws.on('error', reject);
    });
  }

  send(cmd, quiet = false) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(cmd);
    if (!quiet) this.sent.push({ at: Date.now(), cmd });
    return true;
  }

  close() { clearInterval(this.beat); clearInterval(this.claim); clearInterval(this.pilot); this.ws?.close(); }

  // The simulator only has "0.5 km/h faster / slower" buttons, so step towards the target speed.
  // Status frames arrive slower than we send, so count our own steps and only re-sync from the
  // reported speed once the commands have had time to land.
  setSpeed(kph) {
    const now = Date.now();
    if (this.cmdKph === undefined || now - (this.cmdAt || 0) > 1500) this.cmdKph = this.state.simSpeedKph ?? 0;
    const steps = Math.round((kph - this.cmdKph) / 0.5);
    if (!steps) return;
    for (let k = 0; k < Math.abs(steps); k++) this.send(steps > 0 ? 'sim.speedUp' : 'sim.speedDown', true);
    this.cmdKph += steps * 0.5;
    this.cmdAt = now;
  }

  // Drive through a list of waypoints, in local metres east/north of the instance's origin.
  // Steering is a simple proportional controller on heading error, sent 10 times a second.
  // Resolves with {arrived, reason, seconds} when the last waypoint is reached, or early if stop() is called.
  driveRoute(points, { kph = 10, radius = 3, maxSteer = 35, gain = 1.2 } = {}) {
    clearInterval(this.pilot);
    const started = Date.now();
    let i = 0;
    this.route = { points, index: 0, kph };
    return new Promise((resolve) => {
      const finish = (arrived, reason) => {
        clearInterval(this.pilot); this.pilot = null;
        this.send('sim.stop', true); this.send('sim.setSteer|0', true); this.cmdKph = 0; this.cmdAt = Date.now();
        this.route = null;
        resolve({ arrived, reason, seconds: (Date.now() - started) / 1000 });
      };
      this.stop = (reason = 'stopped') => finish(false, reason);
      this.pilot = setInterval(() => {
        const s = this.state;
        if (!s.connected) return finish(false, 'link lost');
        if (s.e === undefined) return;
        const p = points[i], de = p.e - s.e, dn = p.n - s.n, d = Math.hypot(de, dn);
        if (d < radius) {
          if (++i >= points.length) return finish(true, 'route complete');
          this.route.index = i;
          return;
        }
        let err = Math.atan2(de, dn) - s.heading;          // heading is radians clockwise from north
        err = Math.atan2(Math.sin(err), Math.cos(err));
        const steer = Math.max(-maxSteer, Math.min(maxSteer, err * 180 / Math.PI * gain));
        this.send(`sim.setSteer|${steer.toFixed(1)}`, true);
        // Slow down for sharp turns so the tractor does not circle its target.
        const want = Math.abs(err) > 0.6 ? Math.min(kph, 4) : kph;
        this.setSpeed(want);
      }, 100);
    });
  }

  // Position in metres east/north of a home point, from the absolute lat/lon in status frames.
  // (The app's own east/north change origin whenever a field is opened, so they are not used.)
  setHome(lat, lon) { this.home = { lat, lon }; }
  world() {
    if (this.state.lat === undefined) return null;
    if (this.held) return { ...this.held.w };          // see useField: position is being put back
    return this.rawWorld();
  }
  rawWorld() {
    const s = this.state;
    if (!this.home) this.home = { lat: s.lat, lon: s.lon };
    const r = Math.PI / 180, p0 = this.home.lat * r, p = s.lat * r;
    const mLat = 111132.92 - 559.82 * Math.cos(2 * p0) + 1.175 * Math.cos(4 * p0);
    const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
    return { e: (s.lon - this.home.lon) * mLon, n: (s.lat - this.home.lat) * mLat };
  }

  // Keep driving towards whatever getTarget() returns, or hold still when it returns null.
  //   { e, n, maxKph }                      aim at a point (lanes, turns)
  //   { e, n, from:{e,n}, track:true, ... } hold the straight line from → (e,n) itself, the way a guidance
  //                                         system does: steer out the sideways error as well as the heading
  //                                         error, so a pass is straight from its first metre to its last.
  //   paint:true                            implement on, but only while on that line and between its ends.
  // Steering is always ours, through AgOpenWeb's simulator controls; AgOpenWeb's own autosteer stays off so
  // every pass is driven the same way.
  pursue(getTarget, { radius = 3.5, maxSteer = 35, gain = 1.2 } = {}) {
    clearInterval(this.pilot);
    this.pilot = setInterval(() => {
      const w = this.world(), s = this.state;
      if (!s.connected || !w) return;
      if (this.held) return;                             // do not steer from a position we know is wrong
      if (s.autoSteer && Date.now() - (this.autoAt || 0) > 1200) { this.send('autosteer.toggle', true); this.autoAt = Date.now(); }
      const tg = getTarget();
      const d = tg ? Math.hypot(tg.e - w.e, tg.n - w.n) : 0;
      const stop = () => { this.paint(false); this.setSpeed(0); this.send('sim.setSteer|0', true); this.moving = false; this.onLine = false; };
      if (!tg || tg.maxKph === 0) return stop();
      const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
      let err, steerDeg, painting = false, top = tg.maxKph ?? 20;
      const L = tg.from ? Math.hypot(tg.e - tg.from.e, tg.n - tg.from.n) : 0;
      if (tg.track && L > 0.5) {
        const de = (tg.e - tg.from.e) / L, dn = (tg.n - tg.from.n) / L;                 // along the line
        const along = (w.e - tg.from.e) * de + (w.n - tg.from.n) * dn;
        const xt = (w.e - tg.from.e) * dn - (w.n - tg.from.n) * de;                     // metres to the right of the line
        if (along >= L - 0.3) return stop();                                            // end of the line reached
        err = wrap(Math.atan2(de, dn) - s.heading);
        const v = Math.max(0.8, s.speed || 0);
        steerDeg = (err - Math.atan2(1.4 * xt, v + 1)) * 180 / Math.PI;                 // heading error plus pull back onto the line
        this.onLine = Math.abs(xt) < 0.6 && Math.abs(err) < 0.25;
        painting = !!tg.paint && this.onLine && along >= -0.2 && along <= L + 0.2;
        this.xt = xt;
        if (!this.onLine) top = Math.min(top, 6);                                       // creep until lined up
        if (L - along < 4) top = Math.min(top, 7);                                      // ease off for the turn
      } else {
        if (d < radius) return stop();
        err = wrap(Math.atan2(tg.e - w.e, tg.n - w.n) - s.heading);
        steerDeg = err * 180 / Math.PI * gain;
        this.onLine = false; this.xt = null;
        if (d < 8) top = Math.min(top, 6);
      }
      this.paint(painting);
      this.send(`sim.setSteer|${Math.max(-maxSteer, Math.min(maxSteer, steerDeg)).toFixed(1)}`, true);
      // AgOpenWeb's simulator sometimes drops to a standstill while still reporting its old speed setting
      // (it does this when a field is opened). If we want to move and have not moved for 2 s, start again from zero.
      if ((s.speed || 0) > 0.15) this.stillSince = Date.now();
      else if (Date.now() - (this.stillSince || Date.now()) > 2000) { this.send('sim.stop', true); this.cmdKph = 0; this.cmdAt = Date.now(); this.stillSince = Date.now(); }
      this.setSpeed(Math.abs(err) > 1.0 ? Math.min(top, 4) : Math.abs(err) > 0.5 ? Math.min(top, 7) : top);
      this.moving = true;
    }, 100);
  }

  // Section control (what paints worked ground in AgOpenWeb): manual on while on a pass, everything off otherwise,
  // so turns and drives between fields leave no stripes.
  paint(on) {
    const s = this.state, now = Date.now();
    if (now - (this.paintAt || 0) < 900) return;
    if (s.sectionAuto) { this.send('section.master', true); this.paintAt = now; return; }
    if (!!s.sectionManual !== on) { this.send('section.manual', true); this.paintAt = now; }
  }

  // Open one of AgOpenWeb's own fields, select its first guidance line.
  // Safe to call repeatedly.
  useField(name, job) {
    const s = this.state, now = Date.now();
    this.started ||= {};
    // Opening a field makes AgOpenWeb's simulator jump the tractor to the middle of that field. A real
    // tractor does not teleport, so: remember where it is, open the field, then set it straight back.
    if (this.held) {
      const moved = Math.hypot(this.rawWorld().e - this.held.w.e, this.rawWorld().n - this.held.w.n);
      if (now - this.held.at > 900 && moved > 2 && now - (this.held.sentAt || 0) > 1200) { this.send(`sim.setCoords|${this.held.lat},${this.held.lon}`, true); this.held.sentAt = now; }
      if ((this.held.sentAt && moved <= 2) || (now - this.held.at > 2500 && moved <= 2) || now - this.held.at > 9000) { this.held = null; this.cmdKph = 0; this.cmdAt = now; this.stillSince = now; }
      return;
    }
    if (!name || now - (this.fieldAt || 0) < 2500) return;
    const hold = () => { this.send('sim.stop', true); this.held = { lat: s.lat, lon: s.lon, w: this.rawWorld(), at: now }; };
    if (job && !this.started[job.task]) {
      // A job from the coordinator becomes an AgOpenWeb work session on that field, so AgOpenWeb keeps its
      // own record (job.json, coverage, worked area).
      hold();
      this.send(`field.startJob|${name}\t${job.workType || ''}\t${job.notes || ''}\t${job.task}`);
      this.started[job.task] = now; this.fieldAt = now; this.lineFor = null; return;
    }
    if (s.fieldName !== name) { hold(); this.send(`field.openOnly|${name}`); this.fieldAt = now; this.lineFor = null; return; }
    if (this.lineFor !== name) { this.send('track.select|0'); this.fieldAt = now; this.lineFor = name; }
  }

  decode(buffer) {
    const dv = new DataView(buffer);
    let o = 0;
    const u8 = () => dv.getUint8(o++);
    const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const i64 = () => { const v = Number(dv.getBigInt64(o, true)); o += 8; return v; };
    const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    const f64 = () => { const v = dv.getFloat64(o, true); o += 8; return v; };
    const str = () => { const n = i32(); const s = Buffer.from(buffer, o, n).toString('utf8'); o += n; return s; };
    const s = this.state;
    s.frames++;
    try {
      switch (u8()) {
        case TYPE.SCENE: {
          i64(); s.originLat = f64(); s.originLon = f64(); s.hasField = !!u8(); s.fieldName = str();
          break;
        }
        case TYPE.TICK: {
          i64();
          s.e = f64(); s.n = f64(); s.heading = f32(); s.speed = f32();
          s.fix = u8();
          const sn = i32(); o += sn;
          s.crossTrackError = f32(); s.guidanceActive = !!u8(); s.lineLabel = str();
          str();                                   // active track name
          o += 8 + 8 + 4 + 1;                      // tool pose
          s.autoSteer = !!u8(); s.autoSteerAvail = !!u8(); u8(); s.sectionAuto = !!u8(); s.sectionManual = !!u8();
          s.tickAt = Date.now();
          break;
        }
        case TYPE.STATUS: {
          s.fixQuality = i32(); s.fixText = str(); f32(); s.sats = i32();
          o += 5;                                  // isMetric + 4 module-ok flags
          str(); str(); str();                     // module IPs
          o += 4;                                  // 4 configured flags
          s.jobName = str(); s.workedAreaSqM = f64();
          s.lat = f64(); s.lon = f64(); f32(); f32();
          s.simEnabled = !!u8(); s.simSpeedKph = f32(); s.simSteerAngle = f32(); s.sim10x = !!u8();
          s.statusAt = Date.now();
          break;
        }
      }
    } catch (err) {
      s.decodeError = err.message;
    }
  }
}
