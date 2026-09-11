'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const TUNNEL_NAME = 'ClopVPN';

function profileText(privateKey, profile, { includeDns = true } = {}) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(privateKey || ''))) throw new Error('Некорректный приватный ключ.');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(String(profile?.serverPublicKey || ''))) throw new Error('Сервер вернул некорректный ключ.');
  if (!/^10\.77\.\d{1,3}\.\d{1,3}\/32$/.test(String(profile?.address || ''))) throw new Error('Сервер вернул некорректный адрес.');
  if (!/^[a-zA-Z0-9.-]+:\d{2,5}$/.test(String(profile?.endpoint || ''))) throw new Error('Сервер вернул некорректную точку подключения.');
  const dns = Array.isArray(profile.dns) ? profile.dns.join(', ') : '1.1.1.1, 1.0.0.1';
  const dnsLine = includeDns ? `DNS = ${dns}\n` : '';
  return `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${profile.address}\n${dnsLine}\n[Peer]\nPublicKey = ${profile.serverPublicKey}\nEndpoint = ${profile.endpoint}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
}

function wireGuardPath(env = process.env) {
  if (process.platform !== 'win32') return '';
  const candidates = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter(Boolean).map((root) => path.join(root, 'WireGuard', 'wireguard.exe'));
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function hasCommand(command, args = ['--version']) {
  try { await exec(command, args, { timeout: 5_000, windowsHide: true }); return true; } catch { return false; }
}

async function dependencyState() {
  if (process.platform === 'win32') {
    const executable = wireGuardPath();
    return { ready: Boolean(executable), platform: 'windows', executable, label: executable ? 'WireGuard установлен' : 'Нужен официальный WireGuard' };
  }
  if (process.platform === 'linux') {
    const ready = await hasCommand('wg-quick', ['--help']);
    return { ready, platform: 'linux', executable: ready ? 'wg-quick' : '', label: ready ? 'WireGuard установлен' : 'Нужен пакет wireguard-tools' };
  }
  return { ready: false, platform: process.platform, executable: '', label: 'Эта система пока не поддерживается' };
}

async function runPowerShell(script, args = []) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exec(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { timeout: 120_000, windowsHide: true });
}

async function connect(configPath, helperPath) {
  const dependency = await dependencyState();
  if (!dependency.ready) throw new Error(dependency.label);
  if (process.platform === 'win32') {
    await runPowerShell(helperPath, ['up', dependency.executable, configPath, TUNNEL_NAME]);
  } else {
    await exec('pkexec', ['wg-quick', 'up', configPath], { timeout: 120_000 });
  }
}

async function disconnect(configPath, helperPath) {
  const dependency = await dependencyState();
  if (!dependency.ready) return;
  if (process.platform === 'win32') {
    await runPowerShell(helperPath, ['down', dependency.executable, configPath, TUNNEL_NAME]);
  } else {
    await exec('pkexec', ['wg-quick', 'down', configPath], { timeout: 120_000 });
  }
}

async function connected() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await exec('sc.exe', ['query', `WireGuardTunnel$${TUNNEL_NAME}`], { timeout: 5_000, windowsHide: true });
      // The STATE label is localized and Node decodes legacy Windows output poorly.
      // RUNNING remains stable, so detect it without depending on the translated label.
      return /\bRUNNING\b/i.test(stdout);
    } catch { return false; }
  }
  if (process.platform === 'linux') {
    try { await exec('ip', ['link', 'show', 'dev', TUNNEL_NAME], { timeout: 5_000 }); return true; } catch { return false; }
  }
  return false;
}

module.exports = { TUNNEL_NAME, profileText, wireGuardPath, dependencyState, connect, disconnect, connected };
