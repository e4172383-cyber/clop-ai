FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=9090 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json quota.js server.js ./

RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 9090
CMD ["node", "server.js"]
