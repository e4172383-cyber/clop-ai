import fs from 'node:fs';
import os from 'node:os';

const clampPercent = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function readNumber(path) {
  try {
    const value = fs.readFileSync(path, 'utf8').trim();
    return value === 'max' ? null : Number(value);
  } catch {
    return null;
  }
}

function memoryPercent() {
  const used = readNumber('/sys/fs/cgroup/memory.current');
  const limit = readNumber('/sys/fs/cgroup/memory.max');
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return clampPercent((used / limit) * 100);
  }
  const total = os.totalmem();
  return clampPercent(((total - os.freemem()) / Math.max(1, total)) * 100);
}

function diskPercent() {
  try {
    const stats = fs.statfsSync('/app');
    const total = Number(stats.blocks) || 0;
    const available = Number(stats.bavail) || 0;
    return clampPercent(((total - available) / Math.max(1, total)) * 100);
  } catch {
    try {
      const stats = fs.statfsSync(process.cwd());
      const total = Number(stats.blocks) || 0;
      const available = Number(stats.bavail) || 0;
      return clampPercent(((total - available) / Math.max(1, total)) * 100);
    } catch {
      return 0;
    }
  }
}

function cpuSnapshot() {
  try {
    const line = fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/^usage_usec\s+(\d+)/m);
    if (!line) return null;
    const quota = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    const cores = quota[0] === 'max' ? os.availableParallelism() : Number(quota[0]) / Math.max(1, Number(quota[1]));
    return { usage: Number(line[1]), cores: Math.max(0.01, cores) };
  } catch {
    return null;
  }
}

function hostCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cpuPercent(sampleMs = 220) {
  const cgroupBefore = cpuSnapshot();
  const hostBefore = cgroupBefore ? null : hostCpuSnapshot();
  const startedAt = Date.now();
  await wait(sampleMs);
  if (cgroupBefore) {
    const after = cpuSnapshot();
    if (after) {
      const elapsedUs = Math.max(1, Date.now() - startedAt) * 1000;
      return clampPercent(((after.usage - cgroupBefore.usage) / (elapsedUs * cgroupBefore.cores)) * 100);
    }
  }
  const after = hostCpuSnapshot();
  const idleDelta = after.idle - hostBefore.idle;
  const totalDelta = after.total - hostBefore.total;
  return clampPercent((1 - idleDelta / Math.max(1, totalDelta)) * 100);
}

export async function getServerMetrics() {
  const [cpu, memory, disk] = await Promise.all([
    cpuPercent(),
    Promise.resolve(memoryPercent()),
    Promise.resolve(diskPercent()),
  ]);
  return { cpu, memory, disk, measuredAt: Date.now() };
}

export function formatServerStatus(metrics) {
  const cpu = clampPercent(metrics?.cpu);
  const memory = clampPercent(metrics?.memory);
  const disk = clampPercent(metrics?.disk);
  const peak = Math.max(cpu, memory, disk);
  const status = peak >= 90 ? 'Высокая нагрузка' : peak >= 70 ? 'Повышенная нагрузка' : 'Работает стабильно';
  const icon = peak >= 90 ? '🔴' : peak >= 70 ? '🟡' : '🟢';
  const meter = (value) => `${'█'.repeat(Math.round(value / 10))}${'░'.repeat(10 - Math.round(value / 10))} *${value}%*`;
  return [
    '🖥 *Состояние сервера Clop*',
    '',
    `${icon} *${status}*`,
    '',
    `Процессор  ${meter(cpu)}`,
    `Память       ${meter(memory)}`,
    `Хранилище ${meter(disk)}`,
    '',
    '_Показатели измерены сейчас. Нажмите «Обновить», чтобы проверить ещё раз._',
  ].join('\n');
}
