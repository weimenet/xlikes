#!/bin/sh
# 生成 Xlikes 自签名 HTTPS 证书（局域网使用）
set -e
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -nodes \
  -subj "/CN=<host-ip>" \
  -addext "subjectAltName=IP:<host-ip>,DNS:localhost,DNS:*.local"
echo "证书已生成: certs/cert.pem certs/key.pem"
