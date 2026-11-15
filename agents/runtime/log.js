// Durable append-only log (JSON lines). Every entry is written and fsync'd before the
// runtime acts on it, so after a crash the file is the truth and state is rebuilt from it.
// No database server, no native modules.
import fs from 'node:fs';
import path from 'node:path';

export class DurableLog {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.seq = 0;
    this.torn = 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          this.entries.push(e);
          if (e.seq > this.seq) this.seq = e.seq;
        } catch {
          this.torn++; // a line cut off by a crash mid-write: ignore it
        }
      }
      if (text.length && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
    }
    this.fd = fs.openSync(file, 'a');
  }

  append(kind, data = {}) {
    const e = { ...data, seq: ++this.seq, ts: new Date().toISOString(), kind };
    fs.writeSync(this.fd, JSON.stringify(e) + '\n');
    fs.fsyncSync(this.fd);
    this.entries.push(e);
    return e;
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
  }
}
