import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const firstLine = lines[0];
  if (firstLine && !firstLine.includes('=') && !process.env.DISCORD_TOKEN) {
    process.env.DISCORD_TOKEN = firstLine;
  }

  dotenv.config({ path: envPath });
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment value: ${name}`);
  }
  return value;
}

function optionalIntEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function loadServers() {
  const configPath = path.join(PROJECT_ROOT, 'config', 'servers.json');
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(parsed.servers) || parsed.servers.length === 0) {
    throw new Error('config/servers.json must contain at least one server');
  }

  return parsed.servers.map((server) => {
    if (!server.name || !server.directory) {
      throw new Error('Each server needs name and directory fields');
    }

    const directory = path.resolve(server.directory);
    return {
      name: server.name,
      directory,
      logPath: server.logPath ? path.resolve(server.logPath) : path.join(directory, 'logs', 'latest.log'),
      tmuxSession: server.tmuxSession || path.basename(directory),
    };
  });
}

export function loadConfig() {
  loadEnv();

  const discordToken = requireEnv('DISCORD_TOKEN');
  const discordUserId = requireEnv('DISCORD_USER_ID');
  if (!/^\d{15,25}$/.test(discordUserId)) {
    throw new Error('DISCORD_USER_ID must be your numeric Discord user ID, not your username');
  }

  return {
    projectRoot: PROJECT_ROOT,
    discordToken,
    discordUserId,
    pollMs: optionalIntEnv('POLL_MS', 1000),
    cooldownMs: optionalIntEnv('COOLDOWN_SECONDS', 60) * 1000,
    servers: loadServers(),
  };
}
