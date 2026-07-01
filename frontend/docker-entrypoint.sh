#!/bin/sh
set -eu

export MAX_UPLOAD_SIZE_MB="${MAX_UPLOAD_SIZE_MB:-50}"

envsubst '${MAX_UPLOAD_SIZE_MB}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
