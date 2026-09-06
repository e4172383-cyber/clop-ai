const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, amount) => a.map((value, index) => value + (b[index] - value) * amount);

function roundedRectDistance(x, y, centerX, centerY, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x - centerX) - (halfWidth - radius);
  const qy = Math.abs(y - centerY) - (halfHeight - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared ? clamp(((x - ax) * dx + (y - ay) * dy) / lengthSquared) : 0;
  return Math.hypot(x - (ax + dx * amount), y - (ay + dy * amount));
}

function cMark(x, y, offsetX = 0, offsetY = 0) {
  const cx = 0.43 + offsetX;
  const cy = 0.5 + offsetY;
  const radius = 0.228;
  const halfStroke = 0.047;
  const dx = x - cx;
  const dy = y - cy;
  const angle = Math.atan2(dy, dx);
  const onArc = Math.abs(Math.hypot(dx, dy) - radius) <= halfStroke && Math.abs(angle) >= 0.7;
  const upper = [cx + Math.cos(-0.7) * radius, cy + Math.sin(-0.7) * radius];
  const lower = [cx + Math.cos(0.7) * radius, cy + Math.sin(0.7) * radius];
  return onArc || Math.hypot(x - upper[0], y - upper[1]) <= halfStroke || Math.hypot(x - lower[0], y - lower[1]) <= halfStroke;
}

function chevronMark(x, y, offsetX = 0, offsetY = 0) {
  const stroke = 0.027;
  const tipX = 0.765 + offsetX;
  const tipY = 0.5 + offsetY;
  return segmentDistance(x, y, 0.66 + offsetX, 0.39 + offsetY, tipX, tipY) <= stroke
    || segmentDistance(x, y, tipX, tipY, 0.66 + offsetX, 0.61 + offsetY) <= stroke;
}

function composite(pixel, color, alpha) {
  const remaining = 1 - alpha;
  pixel[0] = color[0] * alpha + pixel[0] * remaining;
  pixel[1] = color[1] * alpha + pixel[1] * remaining;
  pixel[2] = color[2] * alpha + pixel[2] * remaining;
  pixel[3] = alpha + pixel[3] * remaining;
}

function sample(x, y) {
  const pixel = [0, 0, 0, 0];
  const rect = roundedRectDistance(x, y, 0.5, 0.49, 0.435, 0.435, 0.16);
  const shadow = roundedRectDistance(x, y, 0.5, 0.512, 0.435, 0.435, 0.16);

  if (shadow < 0.08) {
    const shadowAlpha = 0.3 * Math.exp(-Math.max(0, shadow) * 44);
    composite(pixel, [8, 11, 31], shadowAlpha);
  }

  if (rect <= 0) {
    const direction = clamp(0.1 + x * 0.28 + y * 0.62);
    let background = mix([112, 89, 255], [31, 42, 126], direction);
    const glow = clamp(1 - Math.hypot(x - 0.27, y - 0.2) / 0.58);
    background = mix(background, [135, 107, 255], glow * 0.28);
    composite(pixel, background, 1);

    if (rect > -0.012) composite(pixel, [225, 228, 255], 0.19 * (1 + rect / 0.012));
    const sheen = clamp(1 - Math.hypot(x - 0.2, y - 0.11) / 0.54);
    composite(pixel, [255, 255, 255], sheen * 0.055);
  }

  if (cMark(x, y, 0.006, 0.012)) composite(pixel, [8, 12, 42], 0.25);
  if (chevronMark(x, y, 0.006, 0.012)) composite(pixel, [8, 12, 42], 0.25);
  if (cMark(x, y)) composite(pixel, [247, 248, 255], 1);
  if (chevronMark(x, y)) composite(pixel, [112, 244, 224], 1);

  return pixel;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size >= 512 ? 3 : 4;
  const sampleCount = samples * samples;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const value = sample(x, y);
          totals[0] += value[0];
          totals[1] += value[1];
          totals[2] += value[2];
          totals[3] += value[3];
        }
      }

      const index = (py * size + px) * 4;
      const alpha = totals[3] / sampleCount;
      const alphaDivisor = alpha || 1;
      pixels[index] = Math.round(clamp(totals[0] / sampleCount / alphaDivisor, 0, 255));
      pixels[index + 1] = Math.round(clamp(totals[1] / sampleCount / alphaDivisor, 0, 255));
      pixels[index + 2] = Math.round(clamp(totals[2] / sampleCount / alphaDivisor, 0, 255));
      pixels[index + 3] = Math.round(clamp(alpha) * 255);
    }
  }

  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

fs.mkdirSync(buildDir, { recursive: true });
const appPng = encodePng(512, render(512));
const windowsPng = encodePng(256, render(256));
fs.writeFileSync(path.join(buildDir, 'icon.png'), appPng);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(windowsPng));
console.log(`Created build/icon.png and build/icon.ico (${path.basename(root)})`);
