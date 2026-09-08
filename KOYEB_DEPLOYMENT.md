# Развёртывание Clop на Koyeb

Clop запускается как один постоянно работающий Web Service из корневого
`Dockerfile`. В контейнер входят Node.js 22, Codex CLI, Claude Code CLI и Kimi
Code. Установщики приложений контейнер не хранит: они загружаются из GitHub
Releases.

## Создание сервиса

1. В Koyeb выберите **Create Web Service → GitHub**.
2. Подключите репозиторий `e4172383-cyber/clop-ai`, ветка `main`.
3. Builder: **Dockerfile**, путь `/Dockerfile`.
4. Регион: Frankfurt.
5. Для первого запуска: Eco Small, 1 GB RAM. При перезапусках из-за памяти —
   Eco Medium, 2 GB RAM.
6. Exposed port: `8787`, protocol HTTP. Проверка состояния: `GET /health`.

## Открытые переменные

```dotenv
WEB_HOST=0.0.0.0
PUBLIC_URL=https://<домен-сервиса-koyeb>
SELF_URL=https://<домен-сервиса-koyeb>
DOWNLOAD_BASE_URL=https://github.com/e4172383-cyber/clop-ai/releases/download/v2.4.0
CLOUD_API_URL=https://clop-cloud-api-2.onrender.com
```

Koyeb сам передаёт приложению `PORT`. Задавать его вручную не требуется.

## Секреты

Следующие значения добавляются только через **Koyeb Secrets** и никогда не
коммитятся в Git:

```text
BOT_TOKEN
CLAUDE_CODE_OAUTH_TOKEN
CODEX_AUTH_JSON_B64
KIMI_AUTH_B64
WEB_PASSWORD
ADMIN_IDS
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CLOUD_INTERNAL_SECRET
TOKEN_LIMITS_JSON
CORPORATE_LIMITS_JSON
WEB_SESSION_SECRET
```

После первого успешного запуска проверьте `/health`, `/status.json`, вход через
Telegram, один ответ GPT, один ответ Kimi и сохранение пользователя после
перезапуска сервиса.

## Резервная страница

Каталог `docs/` публикуется через GitHub Pages и остаётся доступным независимо
от API. Для обновления страницы после изменения `src/public/download.html`:

```text
npm run build:fallback
```

Файлы Windows, Linux и Android на резервной странице всегда ведут прямо в
GitHub Releases.
