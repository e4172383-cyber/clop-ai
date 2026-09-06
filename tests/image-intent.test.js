import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsGeneratedImage } from '../src/image-intent.js';

test('detects explicit image generation requests in an ordinary chat', () => {
  for (const text of [
    'Создай картинку кота в космосе',
    'Пожалуйста, нарисуй мне логотип Clop',
    'Можешь сгенерировать фотографию ночного Киева?',
    'сделай аватар для телеграма',
    'сгенерируй фута девушку в красивом фэнтези стиле',
    'нарисуй кота в рыцарских доспехах',
    'Generate an image of a friendly robot',
    'Please create a logo for my project',
  ]) assert.equal(wantsGeneratedImage(text), true, text);
});

test('keeps projects, image analysis and ordinary mentions in the normal AI chat', () => {
  for (const text of [
    'Создай сайт с фотографиями машин',
    'Сделай HTML-код галереи изображений',
    'Создай приложение для обработки фото',
    'Что изображено на этой картинке?',
    'Объясни, как нарисовать картинку самому',
    'Мне нравится это фото',
    'Create a website with product images',
  ]) assert.equal(wantsGeneratedImage(text), false, text);
});
