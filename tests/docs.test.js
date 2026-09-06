import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { extractOffice } from '../src/docs.js';

function oneFileZip(name, content) {
  const nameBytes = Buffer.from(name, 'utf8');
  const plain = Buffer.from(content, 'utf8');
  const compressed = zlib.deflateRawSync(plain);

  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(plain.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(plain.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);

  return Buffer.concat([local, compressed, central, eocd]);
}

test('extracts text from a small Office XML entry', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Привет</w:t></w:r></w:p></w:body></w:document>';
  const result = extractOffice(oneFileZip('word/document.xml', xml), 'sample.docx');
  assert.deepEqual(result, { ok: true, text: 'Привет' });
});

test('refuses an Office zip entry that expands past the safety limit', () => {
  const oversizedXml = `<w:document><w:body><w:t>${'a'.repeat(8 * 1024 * 1024)}</w:t></w:body></w:document>`;
  const result = extractOffice(oneFileZip('word/document.xml', oversizedXml), 'bomb.docx');
  assert.equal(result.ok, false);
  assert.match(result.error, /не нашлось текста/);
});
