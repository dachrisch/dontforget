#!/usr/bin/env zsh
set -e

# Shared worker for scripts/spinup_test_db.sh and scripts/spinup_dev_db.sh —
# not meant to be run directly.
#
# Usage: spinup_mongo.sh <container-name> <host-port> [--fresh]
#
# Ensures servyy-test.lxd is up, then creates/reuses a mongo:8 container on
# it with the given name and host port. All status messages go to stderr;
# stdout gets exactly one line, the servyy-test host IP, so callers can do
# MONGO_HOST=$(./lib/spinup_mongo.sh name port --fresh).

CONTAINER_NAME="$1"
HOST_PORT="$2"
FRESH_START=false
if [[ "$3" == "--fresh" ]]; then
  FRESH_START=true
fi

echo "starting test container" >&2
pushd ~/dev/infrastructure/container/scripts/ > /dev/null
./setup_test_container.sh >&2
popd > /dev/null
sleep 5

echo "starting $CONTAINER_NAME" >&2

if [[ "$FRESH_START" == true ]]; then
  echo "🔄 Fresh start: removing existing database..." >&2
  ssh servyy-test.lxd "docker rm -f $CONTAINER_NAME" 2>/dev/null || true
  sleep 2
  ssh servyy-test.lxd "docker run -d --name $CONTAINER_NAME -p ${HOST_PORT}:27017 mongo:8" >&2
  sleep 10
else
  if ssh servyy-test.lxd "docker ps -a --format '{{.Names}}' | grep -q '^${CONTAINER_NAME}\$'"; then
    echo "♻️  Reusing existing database, restarting container..." >&2
    ssh servyy-test.lxd "docker restart $CONTAINER_NAME" >&2
    sleep 5
  else
    echo "📦 No existing database found, creating new one..." >&2
    ssh servyy-test.lxd "docker run -d --name $CONTAINER_NAME -p ${HOST_PORT}:27017 mongo:8" >&2
    sleep 10
  fi
fi

MONGO_HOST=$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1)
echo "$MONGO_HOST"
