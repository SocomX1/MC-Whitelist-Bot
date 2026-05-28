import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class StateStore {
  constructor(projectRoot) {
    this.dataDir = path.join(projectRoot, 'data');
    this.statePath = path.join(this.dataDir, 'state.json');
    this.state = {
      ignored: {},
      requests: {},
    };
  }

  /*
   * Initialize the data directory and merge any persisted state over the
   * in-memory defaults, allowing new top-level state buckets to get defaults.
   */
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.statePath)) {
      this.save();
      return;
    }

    this.state = {
      ...this.state,
      ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')),
    };
  }

  /*
   * Write through a temporary file so a crash during persistence does not
   * leave state.json partially written.
   */
  save() {
    const tmpPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmpPath, this.statePath);
  }

  ignoreKey(serverName, username, ip) {
    return `${serverName.toLowerCase()}|${username.toLowerCase()}|${ip}`;
  }

  cooldownKey(username, ip) {
    return `${username.toLowerCase()}|${ip}`;
  }

  isIgnored(serverName, username, ip) {
    return Boolean(this.state.ignored[this.ignoreKey(serverName, username, ip)]);
  }

  addIgnored(serverName, username, ip) {
    this.state.ignored[this.ignoreKey(serverName, username, ip)] = {
      serverName,
      username,
      ip,
      ignoredAt: new Date().toISOString(),
    };
    this.save();
  }

  createRequest({ serverName, username, ip, line }) {
    const id = crypto.randomBytes(8).toString('hex');
    this.state.requests[id] = {
      id,
      serverName,
      username,
      ip,
      line,
      status: 'pending',
      alertMessages: [],
      createdAt: new Date().toISOString(),
    };
    this.save();
    return this.state.requests[id];
  }

  getRequest(id) {
    return this.state.requests[id] || null;
  }

  updateRequest(id, updates) {
    if (!this.state.requests[id]) {
      return null;
    }
    this.state.requests[id] = {
      ...this.state.requests[id],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.requests[id];
  }
}
