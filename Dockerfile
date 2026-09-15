FROM node:22-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip \
 && pip install --break-system-packages --no-cache-dir gallery-dl

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY gallery-dl.toml ./

ENV HTTPS_PORT=3000 \
    HTTP_PORT=3080 \
    XLIKES_MEDIA_ROOT=/data/xlikes \
    DATA_DIR=/data/store \
    CERT_DIR=/app/certs

EXPOSE 3000 3080
CMD ["node", "server.js"]
