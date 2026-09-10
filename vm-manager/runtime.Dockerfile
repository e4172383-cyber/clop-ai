FROM node:22-alpine

RUN apk add --no-cache python3 \
    && mkdir -p /home/clop \
    && chown 1000:1000 /home/clop

WORKDIR /home/clop
USER 1000:1000

CMD ["sh"]
