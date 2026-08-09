#!/usr/bin/env zsh
set -e

# Usage: ./scripts/spinup_dev_db.sh [--fresh]
#
# Same pattern as spinup_test_db.sh, but for local dev — a separate
# "dontforget-mongo-dev" container on port 27019, kept apart from the test
# database so resetting one never wipes the other. Dev data is meant to
# persist across sessions; --fresh here is a deliberate wipe, not something
# to run routinely the way you would for the test DB.

cd "$(dirname "$0")"

MONGO_HOST=$(./lib/spinup_mongo.sh dontforget-mongo-dev 27019 "$1")

echo "✅ Dev database is ready at ${MONGO_HOST}:27019"
echo "   export DATABASE_URL=\"mongodb://${MONGO_HOST}:27019/dontforget\""
