import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RestartScheduler } from '../src/restart.js';
import { loadServers } from '../src/config.js';
import { StateStore } from '../src/state.js';

function fixture(overrides = {}) {
  let time = 1000000;
  let pane = { id: '%1', dead: false };
  let originalAlive = true;
  let java = { pid: 10, startTicks: '100', bootId: 'boot', startedAt: 900000 };
  const commands = [];
  const launches = [];
  const server = { name: 'test', directory: '/test', tmuxSession: 'test', autoRestartInterval: 1, restartTimeoutSeconds: 900 };
  const state = { state: { restarts: {} }, save() {} };
  const deps = { servers: [server], state, now: () => time, inspect: async () => pane,
    send: async (target, command) => commands.push(command), launch: async (...args) => launches.push(args),
    processes: { find: async (target) => target && !target.dead ? java : null, isAlive: async () => originalAlive }, validateLauncher: async () => {},
    logger: { log() {}, error() {} }, ...overrides };
  const scheduler = new RestartScheduler(deps);
  scheduler.initialize();
  const record = state.state.restarts[scheduler.key(server)];
  return { scheduler, server, state, deps, record, commands, launches,
    time: (value) => { time = value; }, pane: (value) => { pane = value; if (!value || value.dead) originalAlive = false; },
    exit: () => { originalAlive = false; java = null; },
    replacement: (pid = 11, startTicks = '200') => { originalAlive = false; java = { pid, startTicks, bootId: 'boot', startedAt: time }; } };
}

test('all five warnings precede stop, with no duplicates', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  for (const seconds of [600, 300, 180, 60, 30]) {
    f.time(deadline - seconds * 1000);
    await f.scheduler.tick();
    await f.scheduler.tick();
  }
  f.time(deadline);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.deepEqual(f.commands, [
    'say [Automated notice] Server restarting in 10 minutes.',
    'say [Automated notice] Server restarting in 5 minutes.',
    'say [Automated notice] Server restarting in 3 minutes.',
    'say [Automated notice] Server restarting in 1 minute.',
    'say [Automated notice] Server restarting in 30 seconds.', 'stop',
  ]);
});

test('self-restarting wrapper is never relaunched; success resets deadline', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.time(deadline + 60000);
  await f.scheduler.tick();
  assert.equal(f.launches.length, 0);
  f.replacement();
  await f.scheduler.tick();
  assert.notEqual(f.record.pending, null);
  f.time(deadline + 90000);
  await f.scheduler.tick();
  assert.equal(f.record.pending, null);
  assert.equal(f.record.nextRestartAt, deadline + 60000 + 3600000);
});

test('fallback requires 20 seconds of absence and runs only once', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  // Grace starts when the session disappears, not when stop was sent.
  f.time(deadline + 120000);
  f.pane(null);
  await f.scheduler.tick();
  f.time(deadline + 139999);
  await f.scheduler.tick();
  assert.equal(f.launches.length, 0);
  f.time(deadline + 140000);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0][1], null);
});

test('session returning during grace cancels fallback', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.pane(null);
  await f.scheduler.tick();
  f.time(deadline + 20000);
  f.pane({ id: '%2', dead: false });
  await f.scheduler.tick();
  assert.equal(f.launches.length, 0);
  assert.equal(f.record.pending.absentSince, null);
});

test('dead original pane uses respawn fallback', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.pane({ id: '%1', dead: true });
  await f.scheduler.tick();
  f.time(deadline + 20000);
  await f.scheduler.tick();
  assert.equal(f.launches[0][1].id, '%1');
});

test('missing sessions are skipped for a full interval', async () => {
  const f = fixture();
  f.pane(null);
  f.time(f.record.nextRestartAt);
  await f.scheduler.tick();
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.launches, []);
  assert.equal(f.record.nextRestartAt, 8200000);
});

test('timeout does not force termination or immediately retry', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.time(deadline + 900000);
  await f.scheduler.tick();
  await f.scheduler.tick();
  assert.deepEqual(f.commands, ['stop']);
  assert.equal(f.record.pending, null);
  assert.equal(f.launches.length, 0);
});

test('bot restart preserves deadline, suppresses missed warnings, resumes pending stop', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline - 45000);
  const resumed = new RestartScheduler(f.deps);
  resumed.initialize();
  await resumed.tick();
  assert.deepEqual(f.commands, []);
  assert.equal(f.record.nextRestartAt, deadline);
  f.time(deadline);
  await resumed.tick();
  const again = new RestartScheduler(f.deps);
  again.initialize();
  await again.tick();
  assert.deepEqual(f.commands, ['stop']);
});

test('disabled and short intervals do not produce out-of-range warnings', async () => {
  const f = fixture();
  f.server.autoRestartInterval = 0;
  f.scheduler.initialize();
  await f.scheduler.tick();
  assert.deepEqual(f.state.state.restarts, {});
  f.server.autoRestartInterval = 45 / 3600;
  f.scheduler.initialize();
  f.time(1015000);
  await f.scheduler.tick();
  assert.equal(f.commands.length, 1);
  assert.match(f.commands[0], /30 seconds/);
});

test('overlapping ticks and shutdown do not send duplicate stop', async () => {
  let release;
  const f = fixture({ inspect: () => new Promise((resolve) => { release = resolve; }) });
  f.time(f.record.nextRestartAt);
  const first = f.scheduler.tick();
  await f.scheduler.tick();
  f.scheduler.stop();
  release({ id: '%1', dead: false });
  await first;
  assert.deepEqual(f.commands, []);
});

test('launcher validation fails before stop', async () => {
  const f = fixture({ validateLauncher: async () => { throw new Error('missing tmux.sh'); } });
  f.time(f.record.nextRestartAt);
  await f.scheduler.tick();
  assert.deepEqual(f.commands, []);
  assert.equal(f.record.pending, null);
});

test('configuration validates hours, timeout and duplicate sessions', () => {
  const server = { name: 'test', directory: '/test' };
  for (const value of [-1, '6', Infinity, 0.000001]) {
    assert.throws(() => loadServers({ servers: [{ ...server, autoRestartInterval: value }] }));
  }
  assert.equal(loadServers({ servers: [server] })[0].autoRestartInterval, 0);
  assert.equal(loadServers({ servers: [{ ...server, autoRestartInterval: 0.5 }] })[0].autoRestartInterval, 0.5);
  assert.throws(() => loadServers({ servers: [{ ...server, restartTimeoutSeconds: -1 }] }));
  assert.throws(() => loadServers({ servers: [1, 2].map(() => ({ ...server, autoRestartInterval: 1 })) }));
});

test('existing state gains restart defaults and deadlines persist on disk', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'data'));
  await fs.writeFile(path.join(directory, 'data/state.json'), '{"ignored":{},"requests":{}}');
  const state = new StateStore(directory);
  state.load();
  assert.deepEqual(state.state.restarts, {});
  state.state.restarts.test = { nextRestartAt: 1234 };
  state.save();
  const reloaded = new StateStore(directory);
  reloaded.load();
  assert.equal(reloaded.state.restarts.test.nextRestartAt, 1234);
});


test('an unchanged JVM cannot count as a restart even if its wrapper stays alive', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.time(deadline + 60000);
  await f.scheduler.tick();
  assert.notEqual(f.record.pending, null);
  assert.equal(f.record.pending.candidate, null);
  assert.equal(f.launches.length, 0);
});

test('a crashing replacement must begin a new stability window, even with reused PID', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.time(deadline + 10000);
  f.replacement();
  await f.scheduler.tick();
  f.time(deadline + 30000);
  f.replacement(11, '300');
  await f.scheduler.tick();
  f.time(deadline + 40000);
  await f.scheduler.tick();
  assert.notEqual(f.record.pending, null);
  f.time(deadline + 60000);
  await f.scheduler.tick();
  assert.equal(f.record.pending, null);
  assert.equal(f.record.nextRestartAt, deadline + 30000 + 3600000);
});

test('live orphaned original prevents fallback after session disappears', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.pane(null);
  f.deps.processes.isAlive = async () => true;
  await f.scheduler.tick();
  f.time(deadline + 30000);
  await f.scheduler.tick();
  assert.equal(f.launches.length, 0);
});

test('pending process identity and stability survive a bot restart', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.time(deadline + 10000);
  f.replacement();
  await f.scheduler.tick();
  f.state.state = JSON.parse(JSON.stringify(f.state.state));
  const resumed = new RestartScheduler(f.deps);
  resumed.initialize();
  f.time(deadline + 40000);
  await resumed.tick();
  const record = f.state.state.restarts[resumed.key(f.server)];
  assert.equal(record.pending, null);
  assert.deepEqual(f.commands, ['stop']);
});

test('legacy pending log-based restart is deferred without sending stop or launching', async () => {
  const f = fixture();
  f.record.pending = { startedAt: 1000000, cursor: {} };
  await f.scheduler.tick();
  assert.equal(f.record.pending, null);
  assert.deepEqual(f.commands, []);
  assert.equal(f.launches.length, 0);
});

test('idle wrapper at deadline is skipped without sending stop', async () => {
  const f = fixture();
  f.exit();
  f.time(f.record.nextRestartAt);
  await f.scheduler.tick();
  assert.deepEqual(f.commands, []);
  assert.equal(f.record.pending, null);
});

test('a live replacement that escapes the pane cannot trigger duplicate fallback', async () => {
  const f = fixture();
  const deadline = f.record.nextRestartAt;
  f.time(deadline);
  await f.scheduler.tick();
  f.replacement();
  await f.scheduler.tick();
  f.pane(null);
  f.deps.processes.isAlive = async (identity) => identity.pid === 11;
  f.time(deadline + 40000);
  await f.scheduler.tick();
  assert.equal(f.launches.length, 0);
  assert.notEqual(f.record.pending, null);
  assert.equal(f.record.pending.stableSince, null);
});
