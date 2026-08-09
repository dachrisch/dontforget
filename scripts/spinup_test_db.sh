#!/usr/bin/env zsh
set -e

# Usage: ./scripts/spinup_test_db.sh [--fresh]
#
# Docker is only allowed on servyy-test, never on the local laptop — mirrors
# ~/dev/leaguesphere/container/spinup_test_db.sh exactly, swapping its
# mariadb container for a mongo:8 one. Ensures the shared servyy-test LXD
# host is up (~/dev/infrastructure/container/scripts/setup_test_container.sh),
# then creates/reuses a "dontforget-mongo" container on it over SSH.
#
# servyy-test is shared across apps — another app (job-search) already binds
# host port 27017 with its own mongo:8 container, so this one publishes on
# 27018 instead to avoid colliding with it.
#
# --fresh: removes the existing container and starts a clean one.

FRESH_START=false
if [[ "$1" == "--fresh" ]]; then
  FRESH_START=true
fi

CONTAINER_NAME=dontforget-mongo
HOST_PORT=27018

echo "starting test container"
pushd ~/dev/infrastructure/container/scripts/
./setup_test_container.sh
popd
sleep 5

echo "starting test mongo"

if [[ "$FRESH_START" == true ]]; then
  echo "🔄 Fresh start: removing existing database..."
  ssh servyy-test.lxd "docker rm -f $CONTAINER_NAME" 2>/dev/null || true
  sleep 2
  ssh servyy-test.lxd "docker run -d --name $CONTAINER_NAME -p ${HOST_PORT}:27017 mongo:8"
  sleep 10
else
  if ssh servyy-test.lxd "docker ps -a --format '{{.Names}}' | grep -q '^${CONTAINER_NAME}\$'"; then
    echo "♻️  Reusing existing database, restarting container..."
    ssh servyy-test.lxd "docker restart $CONTAINER_NAME"
    sleep 5
  else
    echo "📦 No existing database found, creating new one..."
    ssh servyy-test.lxd "docker run -d --name $CONTAINER_NAME -p ${HOST_PORT}:27017 mongo:8"
    sleep 10
  fi
fi

MONGO_HOST=$(lxc list servyy-test --format json | jq -r '.[0].state.network.eth0.addresses[] | select(.family=="inet") | .address' | head -n 1)

echo "✅ Test database is ready at ${MONGO_HOST}:${HOST_PORT}"
echo "   export TEST_DATABASE_URL=\"mongodb://${MONGO_HOST}:${HOST_PORT}/dontforget-test\""
