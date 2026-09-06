import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let installedAt = '';

export function ensureImageSkill(root, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const source = path.join(root, 'skills', 'imagegen', 'SKILL.md');
  const destination = path.join(codexHome, 'skills', 'imagegen', 'SKILL.md');
  if (installedAt === destination && fs.existsSync(destination)) return destination;
  if (!fs.existsSync(source)) throw new Error('в сборке сервера отсутствует навык imagegen');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  installedAt = destination;
  return destination;
}

