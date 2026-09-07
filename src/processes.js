import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const gone = (error) => ['ENOENT', 'ESRCH'].includes(error.code);

export function parseStat(text) {
  // comm is parenthesized and can itself contain spaces or closing parentheses.
  const end = text.lastIndexOf(')');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error('Invalid /proc process stat');
  return { pid: Number(text.slice(0, text.indexOf(' '))), ppid: Number(fields[1]),
    state: fields[0], startTicks: fields[19] };
}

export const sameProcess = (a, b) => Boolean(a && b && a.pid === b.pid &&
  a.startTicks === b.startTicks && a.bootId === b.bootId);

export class ProcessTracker {
  constructor({ procRoot = '/proc', now = Date.now, clockTicks } = {}) {
    Object.assign(this, { procRoot, now, clockTicks });
  }

  async stat(pid) {
    try {
      return parseStat(await fs.readFile(path.join(this.procRoot, String(pid), 'stat'), 'utf8'));
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
  }

  async bootId() {
    return (await fs.readFile(path.join(this.procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim();
  }

  async isAlive(identity) {
    const stat = await this.stat(identity.pid);
    return Boolean(stat && !['Z', 'X'].includes(stat.state) &&
      sameProcess({ ...stat, bootId: await this.bootId() }, identity));
  }

  async find(pane) {
    if (!pane || pane.dead) return null;
    const root = await this.stat(pane.pid);
    if (!root || ['Z', 'X'].includes(root.state)) return null;
    const entries = await fs.readdir(this.procRoot);
    const pids = entries.filter((entry) => /^\d+$/.test(entry));
    const processes = [];
    // Bound open file descriptors even on hosts with thousands of processes.
    for (let offset = 0; offset < pids.length; offset += 64) {
      processes.push(...(await Promise.all(pids.slice(offset, offset + 64)
        .map((pid) => this.stat(pid)))).filter(Boolean));
    }
    const descendants = new Set([root.pid]);
    let changed;
    do {
      changed = false;
      for (const process of processes) {
        if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
          descendants.add(process.pid);
          changed = true;
        }
      }
    } while (changed);
    const candidates = [];
    for (const process of processes) {
      if (!descendants.has(process.pid) || ['Z', 'X'].includes(process.state)) continue;
      try {
        const executable = await fs.readlink(path.join(this.procRoot, String(process.pid), 'exe'));
        if (path.basename(executable.replace(/ \(deleted\)$/, '')) === 'java') candidates.push(process);
      } catch (error) {
        if (!gone(error)) throw error;
      }
    }
    const currentRoot = await this.stat(root.pid);
    if (!currentRoot || currentRoot.startTicks !== root.startTicks) return null;
    if (candidates.length > 1) throw new Error('Multiple Java processes in Minecraft pane; cannot identify server safely');
    if (!candidates.length) return null;
    const candidate = candidates[0];
    if (this.clockTicks === undefined) {
      const ticks = Number((await exec('getconf', ['CLK_TCK'], { timeout: 10000 })).stdout.trim());
      if (!Number.isFinite(ticks) || ticks <= 0) throw new Error('Cannot determine Linux clock tick rate');
      this.clockTicks = ticks;
    }
    const uptime = Number((await fs.readFile(path.join(this.procRoot, 'uptime'), 'utf8')).split(' ')[0]);
    if (!Number.isFinite(uptime) || uptime < 0) throw new Error('Cannot determine Linux uptime');
    const identity = { pid: candidate.pid, startTicks: candidate.startTicks, bootId: await this.bootId(),
      startedAt: Math.round(this.now() - (uptime - Number(candidate.startTicks) / this.clockTicks) * 1000) };
    return await this.isAlive(identity) ? identity : null;
  }
}
