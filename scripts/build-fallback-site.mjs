import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(root, 'src', 'public', 'download.html');
const outputDir = path.join(root, 'docs');
const releasesBase = 'https://github.com/e4172383-cyber/clop-ai/releases/download';
const releasePage = 'https://github.com/e4172383-cyber/clop-ai/releases/latest';
const apiBase = 'https://clop.195-201-169-74.sslip.io';

export function releaseTagForAsset(name) {
  const desktopVersion = String(name).match(/^Clop-Code-(?:Setup-)?(\d+\.\d+\.\d+)/)?.[1];
  if (desktopVersion) return `v${desktopVersion}`;
  if (name === 'Clop-AI-Mobile-1.0.7.apk') return 'v2.4.1';
  const mobile = /^Clop-VPN-Mobile-(\d+\.\d+\.\d+-beta\.\d+)\.apk$/.exec(name);
  if (mobile) return `vpn-mobile-v${mobile[1]}`;
  const desktopVpn = /^Clop-VPN-(?:Setup-)?(\d+\.\d+\.\d+-beta\.\d+)(?:-linux-x64)?\.(?:exe|tar\.xz)$/.exec(name);
  if (desktopVpn) return `vpn-v${desktopVpn[1]}`;
  const vpnVersion = String(name).match(/^Clop-VPN-(?:Setup-)?(\d+\.\d+\.\d+-beta\.\d+)/)?.[1];
  if (vpnVersion) return `vpn-v${vpnVersion}`;
  throw new Error(`No release tag configured for ${name}`);
}

function releaseUrl(name) {
  return `${releasesBase}/${releaseTagForAsset(name)}/${encodeURIComponent(name)}`;
}

let html = fs.readFileSync(sourcePath, 'utf8');

html = html
  .replace(/href="\/downloads\/([^"?#]+)"/g, (_match, encodedName) => {
    const name = decodeURIComponent(encodedName);
    return `href="${releaseUrl(name)}"`;
  })
  .replaceAll('href="/chat#bots"', 'href="#service-status"')
  .replaceAll('href="/chat#iphone"', `href="${apiBase}/chat#iphone"`)
  .replaceAll('href="/chat#remote"', 'href="#service-status"')
  .replaceAll('href="/chat#bug"', `href="${releasePage}"`)
  .replace('>Создать Telegram-бота <span>↗</span></a>', '>Чат временно переносится <span>↗</span></a>')
  .replace(
    '<main id="top">',
    '<main id="top"><section class="migration-banner glass" id="service-status"><strong>Сайт работает на резервном адресе</strong><span>Скачивание приложений доступно. Чат, бот и API переносятся на новый сервер.</span></section>',
  )
  .replace(
    '</style>',
    '.migration-banner{margin-top:10px;padding:15px 18px;border-radius:17px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-color:rgba(227,181,95,.28);background:rgba(71,53,28,.7)}.migration-banner strong{color:var(--yellow)}.migration-banner span{color:var(--soft);font-size:12px}@media(max-width:650px){.migration-banner{align-items:flex-start;flex-direction:column;gap:5px}}</style>',
  )
  .replace(
    /<script>\r?\n\s*const byId=/,
    `<script>\n    const API_BASE=${JSON.stringify(apiBase)};\n    const byId=`,
  )
  .replace("fetch('/status.json?t='", "fetch(API_BASE+'/status.json?t='");

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'index.html'), html);
fs.writeFileSync(path.join(outputDir, '404.html'), html);
fs.writeFileSync(path.join(outputDir, '.nojekyll'), '');

console.log(`Fallback site generated in ${outputDir}`);
