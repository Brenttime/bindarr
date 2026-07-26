#!/bin/sh
# Runs as root, fixes ownership of the persisted volume, then drops to the
# unprivileged `node` user. A named volume created by an older root-running
# image is root-owned; without this, the non-root process hits EACCES writing
# indexes (see issue #17). The stat guard makes the recursive chown a one-time
# cost: once the top dir is node-owned, later starts skip it.
set -e

mkdir -p /app/database/index /app/database/sets
if [ "$(stat -c %U /app/database)" != "node" ]; then
  echo "entrypoint: taking ownership of /app/database for node user..."
  chown -R node:node /app/database
fi

exec su-exec node "$@"
