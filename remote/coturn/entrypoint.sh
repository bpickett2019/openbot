#!/bin/sh
set -eu
umask 077

if [ -z "${TURN_SHARED_SECRET:-}" ] || [ "${#TURN_SHARED_SECRET}" -lt 32 ]; then
  echo "TURN_SHARED_SECRET must contain at least 32 bytes." >&2
  exit 1
fi
if [ -z "${TURN_PUBLIC_IP:-}" ] || [ -z "${TURN_REALM:-}" ]; then
  echo "TURN_PUBLIC_IP and TURN_REALM are required." >&2
  exit 1
fi

# These values enter a line-based coturn configuration, never a command argument.
for value in "$TURN_PUBLIC_IP" "$TURN_REALM" "$TURN_SHARED_SECRET"; do
  case "$value" in
    *[![:graph:]]*) echo "TURN settings must not contain whitespace or control bytes." >&2; exit 1 ;;
  esac
done

runtime_config="/tmp/openbot-turnserver.conf"
cp /etc/coturn/openbot.conf "$runtime_config"
{
  echo "external-ip=${TURN_PUBLIC_IP}"
  echo "realm=${TURN_REALM}"
  echo "server-name=${TURN_REALM}"
  echo "static-auth-secret=${TURN_SHARED_SECRET}"
  if [ -n "${TURN_MIN_PORT:-}" ]; then
    echo "min-port=${TURN_MIN_PORT}"
  fi
  if [ -n "${TURN_MAX_PORT:-}" ]; then
    echo "max-port=${TURN_MAX_PORT}"
  fi
  if [ -n "${TURN_TLS_CERT_PATH:-}" ] && [ -n "${TURN_TLS_KEY_PATH:-}" ]; then
    echo "cert=${TURN_TLS_CERT_PATH}"
    echo "pkey=${TURN_TLS_KEY_PATH}"
  else
    echo "no-tls"
    echo "no-dtls"
  fi
} >> "$runtime_config"

turnserver -c "$runtime_config" &
turn_pid=$!

forward_term() { kill -TERM "$turn_pid" 2>/dev/null || true; }
forward_drain() { kill -USR1 "$turn_pid" 2>/dev/null || true; }
forward_cert_reload() { kill -USR2 "$turn_pid" 2>/dev/null || true; }
trap forward_term INT TERM
trap forward_drain USR1
trap forward_cert_reload USR2
watcher_pid=""

if [ -n "${TURN_TLS_CERT_PATH:-}" ]; then
  (
    previous=""
    while kill -0 "$turn_pid" 2>/dev/null; do
      current="$(sha256sum "$TURN_TLS_CERT_PATH" 2>/dev/null | cut -d ' ' -f 1 || true)"
      if [ -n "$previous" ] && [ -n "$current" ] && [ "$current" != "$previous" ]; then
        kill -USR2 "$turn_pid" 2>/dev/null || true
      fi
      previous="$current"
      sleep 300
    done
  ) &
  watcher_pid=$!
fi

# A trapped signal interrupts `wait`. Keep PID 1 alive while coturn drains.
status=0
while true; do
  wait "$turn_pid" && status=0 || status=$?
  if ! kill -0 "$turn_pid" 2>/dev/null; then break; fi
done
if [ -n "$watcher_pid" ]; then
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
fi
exit "$status"
