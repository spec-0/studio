#!/usr/bin/env bash
# Check that a notarization ticket is stapled to a file, retrying a few times.
#
# `xcrun stapler validate` asks Apple's ticket service to confirm the ticket,
# and that request sometimes fails with "The network connection was lost" on
# hosted runners. A missing ticket fails every attempt, so retrying keeps the
# check just as strict while riding out a dropped connection.
set -u
file="$1"
for attempt in 1 2 3 4 5; do
  if xcrun stapler validate "$file"; then
    exit 0
  fi
  if [ "$attempt" -lt 5 ]; then
    echo "stapler validate failed (attempt $attempt of 5), trying again in 30 seconds"
    sleep 30
  fi
done
echo "stapler validate failed 5 times for $file"
exit 1
