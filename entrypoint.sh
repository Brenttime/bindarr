#!/bin/sh
# Runs as root, fixes ownership of the persisted volume, then drops to the
# unprivileged `node` user. A named volume created by an older root-running
# image is root-owned; without this, the non-root process hits EACCES writing
# indexes (see issue #17).
set -e

# These are created here, as root, so a fresh volume has them — which means they
# are born root-owned and have to be handed over below.
mkdir -p /app/database/index /app/database/sets

# Everything not owned by node, not just the top directory. The guard used to be
# `stat /app/database != node`, which is true of a volume that has ALREADY been
# handed over once — so a root-owned subdirectory inside it (the mkdir above on
# an upgrade that first introduced it, or files copied into the volume from the
# host) was never fixed, and stayed unwritable forever. That is EACCES on
# `mkdir /app/database/index/.staging-mtg` with a database directory that looks
# perfectly fine.
#
# find touches only what is actually wrong, so a correct volume costs one stat
# walk and no writes at all.
if [ -n "$(find /app/database ! -user node -print -quit)" ]; then
  echo "entrypoint: taking ownership of /app/database for node user..."
  find /app/database ! -user node -exec chown node:node {} +
fi

exec gosu node "$@"
