import { spawn } from 'node:child_process';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/*
 * Execute tmux directly without a shell so session names and generated
 * commands are passed as arguments rather than interpolated into a command
 * string.
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...options,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} failed with exit ${code}: ${stderr || stdout}`);
      error.stderr = stderr;
      reject(error);
    });
  });
}

const runTmux = (args) => runCommand('tmux', args);

export async function inspectServer(server) {
  try {
    await runTmux(['has-session', '-t', `=${server.tmuxSession}`]);
  } catch (error) {
    if (/can't find session|no server running|error connecting to .*No such file or directory/.test(error.stderr || '')) return null;
    throw error;
  }
  const { stdout } = await runTmux(['list-panes', '-s', '-t', `=${server.tmuxSession}`, '-F', '#{pane_id} #{pane_dead} #{pane_pid}']);
  const panes = stdout.trim().split('\n');
  if (panes.length !== 1 || !/^%\d+ [01] \d+$/.test(panes[0])) {
    throw new Error('Auto-restart requires exactly one Minecraft pane in the session');
  }
  const [id, dead, pid] = panes[0].split(' ');
  return { id, dead: dead === '1', pid: Number(pid) };
}

export async function sendConsole(pane, command) {
  if (/[\r\n]/.test(command)) throw new Error('Console command must be a single line');
  await runTmux(['send-keys', '-t', pane.id, '-l', command]);
  await runTmux(['send-keys', '-t', pane.id, 'Enter']);
}

export async function launchServer(server, deadPane) {
  if (deadPane) {
    // No -k: never terminate a live process to force a restart.
    await runTmux(['respawn-pane', '-t', deadPane.id]);
  } else {
    await runCommand('bash', ['tmux.sh'], { cwd: server.directory });
  }
}

/*
 * Send Minecraft's whitelist command to the configured tmux session after
 * validating the username matches the game's allowed account-name shape.
 */
export async function addToWhitelist(server, username) {
  if (!USERNAME_RE.test(username)) {
    throw new Error(`Refusing unsafe Minecraft username: ${username}`);
  }

  await runTmux(['send-keys', '-t', server.tmuxSession, `whitelist add ${username}`, 'Enter']);
}
