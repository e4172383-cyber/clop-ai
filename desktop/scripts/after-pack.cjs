const fs = require('node:fs');
const path = require('node:path');

/** Keep the languages supported by the Clop UI and drop Chromium locale packs
 * that otherwise add tens of megabytes to every download. */
exports.default = async function afterPack(context) {
  const locales = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(locales)) return;
  const keep = new Set(['en-US.pak', 'ru.pak', 'uk.pak']);
  for (const entry of fs.readdirSync(locales, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.pak') && !keep.has(entry.name)) {
      fs.rmSync(path.join(locales, entry.name));
    }
  }
};
