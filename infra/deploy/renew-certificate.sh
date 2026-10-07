#!/usr/bin/env bash
set -euo pipefail
docker run --rm --name astella-certbot-renew \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/lib/astella/acme:/var/www/certbot \
  certbot/certbot:v5.4.0 renew --quiet
if docker inspect astella-nginx-1 >/dev/null 2>&1; then
  docker exec astella-nginx-1 nginx -s reload
fi
