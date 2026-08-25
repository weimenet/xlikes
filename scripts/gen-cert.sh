#!/bin/sh
# 生成 Xlikes 自签名 HTTPS 证书（局域网使用）
# 用法：sh scripts/gen-cert.sh                    默认 CN=localhost
#       XLIKES_CERT_CN=<局域网IP或域名> sh scripts/gen-cert.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p certs
CN="${XLIKES_CERT_CN:-localhost}"
if echo "$CN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  SAN="IP:$CN,DNS:localhost,DNS:*.local"
else
  SAN="DNS:$CN,DNS:localhost,DNS:*.local"
fi
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -nodes \
  -subj "/CN=$CN" \
  -addext "subjectAltName=$SAN"
echo "证书已生成: certs/cert.pem certs/key.pem（CN=$CN）"
