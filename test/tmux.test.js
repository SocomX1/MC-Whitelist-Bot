import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectServer, sendConsole, launchServer } from '../src/tmux.js';
import { ProcessTracker, sameProcess } from '../src/processes.js';

test('isolated tmux: detached launch, exact lookup, literal commands and graceful exit', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-tmux-'));
  const originalTmp = process.env.TMUX_TMPDIR;
  const originalTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = directory;
  delete process.env.TMUX;
  t.after(async () => {
    try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch {}
    if (originalTmp === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = originalTmp;
    if (originalTmux !== undefined) process.env.TMUX = originalTmux;
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Use a small simulated server executable named java to exercise real /proc
  // identity and ancestry without requiring Minecraft or a Java compiler.
  await fs.copyFile('/bin/bash', path.join(directory, 'java'));
  await fs.chmod(path.join(directory, 'java'), 0o700);
  await fs.writeFile(path.join(directory, 'wrapper.sh'), './java server.sh\nexit $?\n');
  const tracker = new ProcessTracker();
  await fs.writeFile(path.join(directory, 'tmux.sh'), 'tmux -f /dev/null new -d -s restart-test "bash wrapper.sh"\n');
  await fs.writeFile(path.join(directory, 'server.sh'), 'while IFS= read -r line; do\n  printf "%s\\n" "$line" >> commands.txt\n  if [ "$line" = stop ]; then exit 0; fi\ndone\n');
  const server = { directory, tmuxSession: 'restart-test' };
  assert.equal(await inspectServer(server), null);
  await launchServer(server, null);
  const pane = await inspectServer(server);
  assert.equal(pane.dead, false);
  const original = await tracker.find(pane);
  assert.ok(original);
  assert.notEqual(original.pid, pane.pid);
  assert.ok(Math.abs(Date.now() - original.startedAt) < 10000);
  assert.equal(await inspectServer({ ...server, tmuxSession: 'restart' }), null);
  await sendConsole(pane, 'say Restart in 30 seconds; literal $text');
  await sendConsole(pane, 'stop');
  for (let attempt = 0; attempt < 50 && await inspectServer(server); attempt++) await delay(20);
  assert.equal(await inspectServer(server), null);
  assert.equal(await tracker.isAlive(original), false);
  assert.equal(await fs.readFile(path.join(directory, 'commands.txt'), 'utf8'), 'say Restart in 30 seconds; literal $text\nstop\n');

  await launchServer(server, null);
  const retained = await inspectServer(server);
  // Window scope also supports older tmux releases without set-option -p.
  execFileSync('tmux', ['set-window-option', '-t', retained.id, 'remain-on-exit', 'on']);
  await sendConsole(retained, 'stop');
  for (let attempt = 0; attempt < 50 && !(await inspectServer(server)).dead; attempt++) await delay(20);
  assert.equal((await inspectServer(server)).dead, true);
  await launchServer(server, await inspectServer(server));
  assert.equal((await inspectServer(server)).dead, false);
  const replacement = await tracker.find(await inspectServer(server));
  assert.ok(replacement);
  assert.equal(sameProcess(original, replacement), false);
  execFileSync('tmux', ['split-window', '-d', '-t', retained.id, 'cat']);
  await assert.rejects(inspectServer(server), /exactly one Minecraft pane/);
  execFileSync('tmux', ['kill-session', '-t', '=restart-test']);

  await fs.writeFile(path.join(directory, 'wrapper.sh'), 'while true; do ./java server.sh; sleep 0.1; done\n');
  await launchServer(server, null);
  const wrapper = await inspectServer(server);
  const before = await tracker.find(wrapper);
  assert.ok(before);
  await sendConsole(wrapper, 'stop');
  let after;
  for (let attempt = 0; attempt < 100; attempt++) {
    after = await tracker.find(await inspectServer(server));
    if (after && !sameProcess(before, after)) break;
    await delay(20);
  }
  assert.ok(after);
  assert.equal(sameProcess(before, after), false);
  assert.equal(await tracker.isAlive(before), false);
  assert.equal((await inspectServer(server)).pid, wrapper.pid);

});
