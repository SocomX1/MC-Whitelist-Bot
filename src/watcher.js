import fs from 'node:fs/promises';

const WHITELIST_RE = /Disconnecting ([A-Za-z0-9_]{3,16}) \((?:\/)?([^):]+):\d+\): You are not white-listed on this server!/;

export class LogWatcher {
  constructor({ server, pollMs, onMatch }) {
    this.server = server;
    this.pollMs = pollMs;
    this.onMatch = onMatch;
    this.timer = null;
    this.position = 0;
    this.fileId = null;
    this.running = false;
  }

  /*
   * Begin watching from the current end of the log so old whitelist denials
   * do not produce alerts when the bot starts.
   */
  async start() {
    await this.seekToEnd();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error(`[${this.server.name}] watcher error:`, error.message);
      });
    }, this.pollMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async seekToEnd() {
    try {
      const stat = await fs.stat(this.server.logPath);
      this.fileId = `${stat.dev}:${stat.ino}`;
      this.position = stat.size;
      console.log(`[${this.server.name}] watching ${this.server.logPath}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.fileId = null;
        this.position = 0;
        console.warn(`[${this.server.name}] waiting for ${this.server.logPath}`);
        return;
      }
      throw error;
    }
  }

  /*
   * Poll for appended bytes, resetting to the beginning when the log file is
   * rotated or truncated. The running flag prevents overlapping reads when a
   * slow filesystem operation lasts longer than the polling interval.
   */
  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const stat = await fs.stat(this.server.logPath);
      const fileId = `${stat.dev}:${stat.ino}`;
      if (this.fileId !== fileId || stat.size < this.position) {
        this.fileId = fileId;
        this.position = 0;
      }

      if (stat.size === this.position) {
        return;
      }

      const handle = await fs.open(this.server.logPath, 'r');
      try {
        const length = stat.size - this.position;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.position);
        this.position = stat.size;
        this.processChunk(buffer.toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    } finally {
      this.running = false;
    }
  }

  /*
   * Extract whitelist-denial events from newly read log text and forward only
   * the fields needed by the Discord alert flow.
   */
  processChunk(chunk) {
    for (const line of chunk.split(/\r?\n/)) {
      const match = line.match(WHITELIST_RE);
      if (!match) {
        continue;
      }
      this.onMatch({
        server: this.server,
        username: match[1],
        ip: match[2],
        line,
      });
    }
  }
}
