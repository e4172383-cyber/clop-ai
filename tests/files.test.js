import assert from 'node:assert/strict';
import test from 'node:test';

import { extractFiles, filesForJson, mimeForPath } from '../src/files.js';

test('extracts safe generated files and removes their markers from chat text', () => {
  const source = [
    'Готово.',
    '%%%FILE src/index.js%%%',
    'console.log("ok");',
    '%%%ENDFILE%%%',
    '%%%FILE README.md%%%',
    '# Проект',
    '%%%ENDFILE%%%',
  ].join('\n');

  const result = extractFiles(source);
  assert.equal(result.cleanText, 'Готово.');
  assert.deepEqual(result.files.map((file) => file.path), ['src/index.js', 'README.md']);
});

test('rejects traversal paths and reports an unfinished file marker', () => {
  const result = extractFiles([
    '%%%FILE ../secret.txt%%%',
    'no',
    '%%%ENDFILE%%%',
    'Текст',
    '%%%FILE unfinished.txt%%%',
    'partial',
  ].join('\n'));

  assert.equal(result.files.length, 0);
  assert.equal(result.cleanText, 'Текст');
  assert.equal(result.truncated, 'unfinished.txt');
  assert.equal(result.truncatedContent, 'partial');
});

test('serializes generated files with base64 data, size and MIME', () => {
  const [file] = filesForJson([{ path: 'data.json', content: '{"ok":true}' }]);
  assert.equal(file.name, 'data.json');
  assert.equal(file.mimeType, 'application/json; charset=utf-8');
  assert.equal(file.size, 11);
  assert.equal(Buffer.from(file.data, 'base64').toString('utf8'), '{"ok":true}');
  assert.equal(mimeForPath('unknown.xyz'), 'text/plain; charset=utf-8');
});
