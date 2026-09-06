'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeInlineResponseFile,
  extractMarkedFiles,
  extractResponseFiles,
  normalizeResponseFileCandidate,
  sanitizeOutputName,
} = require('../src/response-files.cjs');

test('extractMarkedFiles removes legacy markers and keeps their UTF-8 file content', () => {
  const result = extractMarkedFiles([
    'Файл готов.',
    '%%%FILE reports/итог.txt%%%',
    'первая строка',
    'вторая строка',
    '%%%ENDFILE%%%',
    'Можно скачать ниже.',
  ].join('\n'));

  assert.equal(result.text, 'Файл готов.\nМожно скачать ниже.');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'итог.txt');
  assert.equal(result.files[0].content, 'первая строка\nвторая строка\n');
  assert.equal(result.files[0].encoding, 'utf8');
});

test('extractResponseFiles accepts API aliases and removes duplicate descriptors', () => {
  const descriptor = { id: 'server-file-1', filename: 'report.csv', mime_type: 'text/csv', data: 'YSxiCg==' };
  const result = extractResponseFiles({ text: 'Готово', output_files: [descriptor], files: [{ ...descriptor }] });
  assert.equal(result.text, 'Готово');
  assert.equal(result.files.length, 1);
});

test('sanitizeOutputName strips paths, invalid characters, and Windows device names', () => {
  assert.equal(sanitizeOutputName('..\\folder\\report?.txt'), 'report_.txt');
  assert.equal(sanitizeOutputName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeOutputName('...'), 'file-1.bin');
});

test('normalizeResponseFileCandidate supports response field aliases', () => {
  const result = normalizeResponseFileCandidate({
    path: 'exports/result.pdf',
    mime_type: 'application/pdf; charset=binary',
    size: 42,
    download_url: '/desk/files/42',
  });
  assert.equal(result.name, 'result.pdf');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.declaredSize, 42);
  assert.equal(result.url, '/desk/files/42');
});

test('decodeInlineResponseFile accepts base64 and data URLs and enforces limits', () => {
  assert.equal(decodeInlineResponseFile({ data: '0J/RgNC40LLQtdGC', encoding: 'base64' }, 100).toString('utf8'), 'Привет');
  assert.equal(decodeInlineResponseFile({ data: 'data:text/plain;charset=utf-8,hello%20world' }, 100).toString('utf8'), 'hello world');
  assert.equal(decodeInlineResponseFile({ data: '', encoding: 'base64' }, 100).length, 0);
  assert.throws(() => decodeInlineResponseFile({ data: '***', encoding: 'base64' }, 100), /base64/i);
  assert.throws(() => decodeInlineResponseFile({ content: 'too long', encoding: 'utf8' }, 3), /размер/i);
});
