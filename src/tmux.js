import { spawn } from 'node:child_process';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function runTmux(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
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
      reject(new Error(`tmux ${args.join(' ')} failed with exit ${code}: ${stderr || stdout}`));
    });
  });
}

export async function addToWhitelist(server, username) {
  if (!USERNAME_RE.test(username)) {
    throw new Error(`Refusing unsafe Minecraft username: ${username}`);
  }

  await runTmux(['send-keys', '-t', server.tmuxSession, `whitelist add ${username}`, 'Enter']);
}
