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
        resolve(this);
      });
      ws.on('message', (data, isBinary) => { if (isBinary) this.decode(data); });
      ws.on('close', () => { this.state.connected = false; clearInterval(this.beat); });
      ws.on('error', reject);
    });
  }

  send(cmd, quiet = false) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(cmd);
    if (!quiet) this.sent.push({ at: Date.now(), cmd });
    return true;
  }

  close() { clearInterval(this.beat); clearInterval(this.pilot); this.ws?.close(); }

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
    const s = this.state;
    if (s.lat === undefined) return null;
    if (!this.home) this.home = { lat: s.lat, lon: s.lon };
    const r = Math.PI / 180, p0 = this.home.lat * r, p = s.lat * r;
    const mLat = 111132.92 - 559.82 * Math.cos(2 * p0) + 1.175 * Math.cos(4 * p0);
    const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
    return { e: (s.lon - this.home.lon) * mLon, n: (s.lat - this.home.lat) * mLat };
  }

  // Keep steering towards whatever getTarget() returns: {e, n, maxKph, follow} in world metres, or null to hold still.
  // With follow:true and a guidance line selected in AgOpenWeb, its own autosteer holds the line and we
  // only set the speed; otherwise we steer ourselves (driving between fields, turning at a field end).
  pursue(getTarget, { radius = 4, maxSteer = 35, gain = 1.2 } = {}) {
    clearInterval(this.pilot);
    const autosteer = (want) => {
      if (!!this.state.autoSteer === want || Date.now() - (this.autoAt || 0) < 1200) return;
      this.send('autosteer.toggle', true); this.autoAt = Date.now();
    };
    this.pilot = setInterval(() => {
      const w = this.world(), s = this.state;
      if (!s.connected || !w) return;
      const tg = getTarget();
      const d = tg ? Math.hypot(tg.e - w.e, tg.n - w.n) : 0;
      this.paint(!!tg && !!tg.paint && d >= radius);
      if (!tg || d < radius) { autosteer(false); this.setSpeed(0); this.send('sim.setSteer|0', true); this.moving = false; this.onLine = false; return; }
      let err = Math.atan2(tg.e - w.e, tg.n - w.n) - s.heading;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      const useLine = !!tg.follow && s.guidanceActive && s.autoSteerAvail && Math.abs(err) < 0.45;
      autosteer(useLine);
      this.onLine = useLine && s.autoSteer;
      if (!this.onLine) {
        const steer = Math.max(-maxSteer, Math.min(maxSteer, err * 180 / Math.PI * gain));
        this.send(`sim.setSteer|${steer.toFixed(1)}`, true);
      }
      const top = tg.maxKph ?? 20;
      this.setSpeed(Math.abs(err) > 1.0 ? Math.min(top, 5) : Math.abs(err) > 0.5 ? Math.min(top, 10) : top);
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
    if (!name || now - (this.fieldAt || 0) < 2500) return;
    this.started ||= {};
    // A job from the coordinator becomes an AgOpenWeb work session on that field, so AgOpenWeb keeps its
    // own record (job.json, coverage, worked area). Without a job we just open the field.
    if (job && !this.started[job.task]) {
      this.send(`field.startJob|${name}\t${job.workType || ''}\t${job.notes || ''}\t${job.task}`);
      this.started[job.task] = now; this.fieldAt = now; this.lineFor = null; return;
    }
    if (s.fieldName !== name) { this.send(`field.openOnly|${name}`); this.fieldAt = now; this.lineFor = null; return; }
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
