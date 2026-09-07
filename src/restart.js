import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectServer, sendConsole, launchServer } from './tmux.js';
import { ProcessTracker, sameProcess } from './processes.js';

const WARNINGS = [600, 300, 180, 60, 30];
const GRACE_MS = 20000;

export class RestartScheduler {
  constructor({ servers, state, now = Date.now, inspect = inspectServer, send = sendConsole,
    launch = launchServer, processes = new ProcessTracker(),
    validateLauncher = (server) => fs.access(path.join(server.directory, 'tmux.sh')), logger = console }) {
    Object.assign(this, { servers, state, now, inspect, send, launch, processes, validateLauncher, logger });
    this.busy = new Set();
    this.stopped = false;
  }

  key(server) { return JSON.stringify([server.directory, server.tmuxSession]); }

  initialize() {
    const now = this.now();
    const keys = new Set();
    for (const server of this.servers.filter((s) => s.autoRestartInterval > 0)) {
      const key = this.key(server);
      keys.add(key);
      const intervalMs = Math.round(server.autoRestartInterval * 3600000);
      let record = this.state.state.restarts[key];
      if (!record || record.intervalMs !== intervalMs) {
        record = { intervalMs, nextRestartAt: now + intervalMs, warnings: [], pending: record?.pending || null };
        this.state.state.restarts[key] = record;
      }
      // Expired warnings are not replayed when the bot comes back online.
      record.warnings = [...new Set([...record.warnings,
        ...WARNINGS.filter((seconds) => record.nextRestartAt - seconds * 1000 < now)])];
    }
    for (const key of Object.keys(this.state.state.restarts)) {
      if (!keys.has(key)) delete this.state.state.restarts[key];
    }
    this.state.save();
  }

  start() {
    this.initialize();
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    void this.tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  finish(server, record, message, startedAt = this.now()) {
    record.pending = null;
    record.nextRestartAt = startedAt + record.intervalMs;
    record.warnings = [];
    this.state.save();
    this.logger.log(`[${server.name}] ${message}; next restart ${new Date(record.nextRestartAt).toISOString()}`);
  }

  async tick() {
    if (this.stopped) return;
    await Promise.all(this.servers.filter((s) => s.autoRestartInterval > 0).map(async (server) => {
      const key = this.key(server);
      if (this.busy.has(key)) return;
      this.busy.add(key);
      const record = this.state.state.restarts[key];
      try {
        await this.check(server, record);
      } catch (error) {
        this.logger.error(`[${server.name}] auto-restart failed: ${error.message}`);
        this.finish(server, record, 'Restart attempt failed (no immediate retry)');
      } finally {
        this.busy.delete(key);
      }
    }));
  }

  async check(server, record) {
    if (record.pending) return this.monitor(server, record);
    const remaining = record.nextRestartAt - this.now();
    if (remaining > 0) {
      const due = WARNINGS.filter((s) => s * 1000 <= record.intervalMs && remaining <= s * 1000 && !record.warnings.includes(s));
      if (!due.length) return;
      record.warnings.push(...due);
      this.state.save();
      const seconds = due.at(-1);
      // Discard stale warnings after a delayed event-loop tick, too.
      if (seconds * 1000 - remaining > 5000) return;
      const pane = await this.inspect(server);
      if (!pane || pane.dead || this.stopped) return;
      const duration = seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? '' : 's'}` : '30 seconds';
      await this.send(pane, `say [Automated notice] Server restarting in ${duration}.`);
      return;
    }
    const pane = await this.inspect(server);
    if (!pane || pane.dead) {
      this.finish(server, record, 'Skipped restart: Minecraft session is absent or exited');
      return;
    }
    await this.validateLauncher(server);
    const original = await this.processes.find(pane);
    if (!original) {
      this.finish(server, record, 'Skipped restart: no Java process in Minecraft pane');
      return;
    }
    if (this.stopped) return;
    // Persist before sending stop: recovery must never blindly send it again.
    record.pending = { startedAt: this.now(), paneId: pane.id, original, candidate: null, stableSince: null, absentSince: null, launched: false };
    this.state.save();
    await this.send(pane, 'stop');
    this.logger.log(`[${server.name}] Sent stop; waiting for restart`);
  }

  async monitor(server, record) {
    const pending = record.pending;
    if (!pending.original) throw new Error('Legacy pending restart lacks process identity; deferring to next interval');
    if (this.now() - pending.startedAt >= server.restartTimeoutSeconds * 1000) {
      throw new Error('Timed out waiting for process restart/stability; no process was forcefully terminated');
    }
    // A live wrapper is not proof of shutdown. Track the original JVM even if
    // it has been reparented or the pane/session has disappeared.
    if (await this.processes.isAlive(pending.original)) return;
    const pane = await this.inspect(server);
    const candidate = await this.processes.find(pane);
    if (pending.candidate && !sameProcess(candidate, pending.candidate) &&
        await this.processes.isAlive(pending.candidate)) {
      // Do not launch over a replacement that has escaped the pane's tree.
      pending.stableSince = null;
      this.state.save();
      return;
    }
    if (candidate && !sameProcess(candidate, pending.original)) {
      if (!sameProcess(candidate, pending.candidate) || pending.stableSince === null) {
        pending.candidate = candidate;
        pending.stableSince = this.now();
      }
      if (this.now() - pending.stableSince >= 30000) {
        this.finish(server, record, 'Replacement Java process stable for 30 seconds', pending.candidate.startedAt);
        return;
      }
    } else {
      pending.candidate = null;
      pending.stableSince = null;
    }
    if (!pane || pane.dead) {
      if (pending.absentSince === null) pending.absentSince = this.now();
      if (!pending.launched && this.now() - pending.absentSince >= GRACE_MS) {
        // Recheck immediately before launch; an existing live session owns recovery.
        const current = await this.inspect(server);
        if (this.stopped) return;
        if (!current || (current.dead && current.id === pending.paneId)) {
          pending.launched = true;
          this.state.save();
          await this.launch(server, current);
          this.logger.log(`[${server.name}] Launched fallback; waiting for Minecraft startup`);
        }
      }
    } else {
      pending.absentSince = null;
    }
    this.state.save();
  }
}
