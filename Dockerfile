FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=8787 \
    HOME=/home/clop

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code @openai/codex \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin clop \
    && chown -R clop:clop /home/clop

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=clop:clop . .

# The app creates its runtime state lazily. WORKDIR itself is created by root,
# so make the application tree writable before dropping privileges.
RUN mkdir -p /app/data && chown -R clop:clop /app

USER clop
EXPOSE 8787

CMD ["node", "index.js"]
