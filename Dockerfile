FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

ENV HTTPS_PORT=3000 \
    HTTP_PORT=3080 \
    XLIKES_MEDIA_ROOT=/data/xlikes \
    DATA_DIR=/data/store \
    CERT_DIR=/app/certs

EXPOSE 3000 3080
CMD ["node", "server.js"]
