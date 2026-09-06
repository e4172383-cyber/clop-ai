const RU_VERB = /(?<![\p{L}\p{N}_])(?:создай|сделай|сгенерируй|нарисуй|изобрази|создать|сделать|сгенерировать|нарисовать|изобразить)(?![\p{L}\p{N}_])/iu;
const RU_IMAGE = /(?<![\p{L}\p{N}_])(?:фото|фотографи[\p{L}-]*|картинк[\p{L}-]*|изображени[\p{L}-]*|арт|арта|аватар[\p{L}-]*|обои|постер[\p{L}-]*|логотип[\p{L}-]*)(?![\p{L}\p{N}_])/iu;
const EN_VERB = /\b(?:create|make|generate|draw|paint|render)\b/iu;
const EN_IMAGE = /\b(?:photo|photograph|picture|image|artwork|avatar|wallpaper|poster|logo)\b/iu;
const PROJECT = /(?<![\p{L}\p{N}_])(?:сайт[\p{L}-]*|веб-?страниц[\p{L}-]*|приложени[\p{L}-]*|презентаци[\p{L}-]*|документ[\p{L}-]*|код[\p{L}-]*|html|css|svg|website|webpage|application|presentation|document|code)(?![\p{L}\p{N}_])/iu;

function orderedIntent(text, verbPattern, imagePattern) {
  const verb = verbPattern.exec(text);
  const image = imagePattern.exec(text);
  if (!verb || !image || image.index < verb.index) return false;
  if (image.index - (verb.index + verb[0].length) > 70) return false;
  if (/(?:как|как мне|научи(?: меня)?|how to)\s*$/iu.test(text.slice(0, verb.index))) return false;

  // «Создай сайт с фотографиями» is a project request. «Создай логотип для
  // сайта» is an image request because the image noun comes first.
  const between = text.slice(verb.index + verb[0].length, image.index);
  return !PROJECT.test(between);
}

export function wantsGeneratedImage(input) {
  const text = String(input || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return false;
  return orderedIntent(text, RU_VERB, RU_IMAGE) || orderedIntent(text, EN_VERB, EN_IMAGE);
}
