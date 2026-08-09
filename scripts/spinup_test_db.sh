#!/usr/bin/env zsh
set -e

# Usage: ./scripts/spinup_test_db.sh [--fresh]
#
# Docker is only allowed on servyy-test, never on the local laptop — mirrors
# ~/dev/leaguesphere/container/spinup_test_db.sh's pattern, swapping mariadb
# for mongo:8. Creates/reuses a dedicated "dontforget-mongo" container,
# kept separate from the dev database (scripts/spinup_dev_db.sh) so a
# `--fresh` test reset never wipes dev data, and vice versa.
#
# servyy-test is shared across apps — job-search already binds host port
# 27017 with its own mongo:8 container, so this one uses 27018.

cd "$(dirname "$0")"

MONGO_HOST=$(./lib/spinup_mongo.sh dontforget-mongo 27018 "$1")

echo "✅ Test database is ready at ${MONGO_HOST}:27018"
echo "   export TEST_DATABASE_URL=\"mongodb://${MONGO_HOST}:27018/dontforget-test\""
