import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureImageSkill } from '../src/image-skill.js';

test('bundled image skill is installed into an empty Codex home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-image-skill-'));
  try {
    const installed = ensureImageSkill(path.resolve('.'), home);
    assert.equal(installed, path.join(home, 'skills', 'imagegen', 'SKILL.md'));
    const text = fs.readFileSync(installed, 'utf8');
    assert.match(text, /built-in `image_gen` tool/);
    assert.match(text, /does not require an `OPENAI_API_KEY`/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
