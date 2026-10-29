#!/bin/sh
set -eu

set -- --path /acme --email "${ACME_EMAIL:?ACME_EMAIL is required}" --accept-tos --dns cloudflare \
  --domains "${SIGNAL_DOMAIN:?SIGNAL_DOMAIN is required}" --domains "${TURN_DOMAIN:?TURN_DOMAIN is required}"
make_certificates_readable() {
  chgrp "${ACME_CERTIFICATE_GROUP_ID}" /acme/certificates
  chgrp "${ACME_CERTIFICATE_GROUP_ID}" "/acme/certificates/${SIGNAL_DOMAIN}.crt" "/acme/certificates/${SIGNAL_DOMAIN}.key"
  chmod 0550 /acme/certificates
  chmod 0440 "/acme/certificates/${SIGNAL_DOMAIN}.crt" "/acme/certificates/${SIGNAL_DOMAIN}.key"
}

if [ ! -f "/acme/certificates/${SIGNAL_DOMAIN}.crt" ]; then
  /lego run "$@"
fi
make_certificates_readable
while true; do
  # lego v5 uses `run` for both initial issuance and renewal. `--renew-days` is the v5 renewal threshold flag.
  /lego run "$@" --renew-days 30
  make_certificates_readable
  sleep 43200
done
