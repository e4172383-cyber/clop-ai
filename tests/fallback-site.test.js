import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const generated = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

test('fallback download buttons point at the release that actually owns each asset', () => {
  assert.match(generated, /releases\/download\/v2\.5\.8\/Clop-Code-Setup-2\.5\.8\.exe/);
  assert.match(generated, /releases\/download\/v2\.5\.8\/Clop-Code-2\.5\.8-linux-x64\.tar\.xz/);
  assert.match(generated, /releases\/download\/v2\.4\.1\/Clop-AI-Mobile-1\.0\.7\.apk/);
  assert.match(generated, /releases\/download\/vpn-v1\.0\.0-beta\.6\/Clop-VPN-Setup-1\.0\.0-beta\.6\.exe/);
  assert.match(generated, /releases\/download\/vpn-mobile-v1\.0\.0-beta\.3\/Clop-VPN-Mobile-1\.0\.0-beta\.3\.apk/);
  assert.doesNotMatch(generated, /releases\/download\/v2\.4\.3\/Clop-(?:Code|VPN)/);
});

test('fallback carries its design stylesheet with a relative path', () => {
  assert.match(generated, /href="taste\.css\?v=1"/);
  assert.ok(fs.readFileSync(new URL('../docs/taste.css', import.meta.url), 'utf8').includes('taste-download'));
});
