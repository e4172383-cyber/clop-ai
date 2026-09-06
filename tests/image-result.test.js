import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGeneratedImage } from '../src/image-result.js';

test('reads the generated image path from the Codex JSON stream', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-image-result-'));
  try {
    const file = path.join(home, 'generated_images', 'result-id', 'image.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'png');
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: `Generated PNG: \`${file}\`` },
    });
    assert.equal(findGeneratedImage(stdout, home, Date.now()), file);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rejects a model-supplied path outside generated_images', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-image-result-'));
  const outside = path.join(os.tmpdir(), 'clop-outside.png');
  try {
    fs.writeFileSync(outside, 'not an allowed result');
    const stdout = JSON.stringify({ item: { type: 'agent_message', text: `Generated PNG: \`${outside}\`` } });
    assert.equal(findGeneratedImage(stdout, home, Date.now()), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    try { fs.unlinkSync(outside); } catch {}
  }
});
