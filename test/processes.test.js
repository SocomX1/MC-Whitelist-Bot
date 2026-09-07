import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessTracker, parseStat, sameProcess } from '../src/processes.js';

function statText(pid, ppid, ticks, state = 'S') {
  return `${pid} (name with ) spaces) ${state} ${ppid} ${Array(17).fill('0').join(' ')} ${ticks}\n`;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sys/kernel/random'), { recursive: true });
  await fs.writeFile(path.join(root, 'sys/kernel/random/boot_id'), 'boot-a\n');
  await fs.writeFile(path.join(root, 'uptime'), '100.00 0.00\n');
  async function add(pid, ppid, ticks, exe = '/usr/bin/bash', state = 'S') {
    await fs.mkdir(path.join(root, String(pid)), { recursive: true });
    await fs.writeFile(path.join(root, String(pid), 'stat'), statText(pid, ppid, ticks, state));
    const link = path.join(root, String(pid), 'exe');
    await fs.rm(link, { force: true });
    await fs.symlink(exe, link);
  }
  const tracker = new ProcessTracker({ procRoot: root, clockTicks: 100, now: () => 1000000 });
  return { root, tracker, add, pane: { id: '%1', pid: 10, dead: false } };
}

test('stat parser handles parenthesized names and preserves precise start ticks', () => {
  assert.deepEqual(parseStat(statText(12, 10, '12345678901234567890')), {
    pid: 12, ppid: 10, state: 'S', startTicks: '12345678901234567890',
  });
  assert.throws(() => parseStat('invalid'));
});

test('finds JVM through nested wrappers and ignores unrelated Java processes', async (t) => {
  const f = await fixture(t);
  await f.add(10, 1, '10');
  await f.add(11, 10, '20');
  await f.add(12, 11, '5000', '/opt/jdk/bin/java');
  await f.add(99, 1, '40', '/opt/jdk/bin/java');
  const identity = await f.tracker.find(f.pane);
  assert.deepEqual(identity, { pid: 12, startTicks: '5000', bootId: 'boot-a', startedAt: 950000 });
  assert.equal(await f.tracker.isAlive(identity), true);
});

test('supports Java as pane root and deleted Java executable', async (t) => {
  const f = await fixture(t);
  await f.add(10, 1, '100', '/opt/jdk/bin/java (deleted)');
  assert.equal((await f.tracker.find(f.pane)).pid, 10);
});

test('PID reuse and host reboot cannot impersonate the original JVM', async (t) => {
  const f = await fixture(t);
  await f.add(10, 1, '100', '/opt/jdk/bin/java');
  const original = await f.tracker.find(f.pane);
  await f.add(10, 1, '200', '/opt/jdk/bin/java');
  assert.equal(await f.tracker.isAlive(original), false);
  assert.equal(sameProcess(original, await f.tracker.find(f.pane)), false);
  await f.add(10, 1, '100', '/opt/jdk/bin/java');
  await fs.writeFile(path.join(f.root, 'sys/kernel/random/boot_id'), 'boot-b\n');
  assert.equal(await f.tracker.isAlive(original), false);
});

test('empty wrappers, dead panes, zombies and disappeared processes are not live JVMs', async (t) => {
  const f = await fixture(t);
  await f.add(10, 1, '100');
  assert.equal(await f.tracker.find(f.pane), null);
  await f.add(11, 10, '200', '/opt/jdk/bin/java', 'Z');
  assert.equal(await f.tracker.find(f.pane), null);
  await f.add(11, 10, '200', '/opt/jdk/bin/java');
  const original = await f.tracker.find(f.pane);
  assert.equal(await f.tracker.find({ ...f.pane, dead: true }), null);
  await fs.rm(path.join(f.root, '11'), { recursive: true });
  assert.equal(await f.tracker.isAlive(original), false);
});

test('ambiguous multiple JVMs fail instead of selecting one', async (t) => {
  const f = await fixture(t);
  await f.add(10, 1, '100');
  await f.add(11, 10, '200', '/opt/jdk/bin/java');
  await f.add(12, 10, '300', '/opt/jdk/bin/java');
  await assert.rejects(f.tracker.find(f.pane), /Multiple Java processes/);
});

test('original JVM remains tracked after it is reparented outside the pane', async (t) => {
  const f = await fixture(t);
  await f.add(10, 1, '100');
  await f.add(11, 10, '200', '/opt/jdk/bin/java');
  const original = await f.tracker.find(f.pane);
  await f.add(11, 1, '200', '/opt/jdk/bin/java');
  assert.equal(await f.tracker.find(f.pane), null);
  assert.equal(await f.tracker.isAlive(original), true);
});

test('unreadable process metadata is an error, not evidence of process exit', async () => {
  const tracker = new ProcessTracker();
  tracker.stat = async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); };
  await assert.rejects(tracker.isAlive({ pid: 10, startTicks: '100', bootId: 'boot' }), { code: 'EACCES' });
});
