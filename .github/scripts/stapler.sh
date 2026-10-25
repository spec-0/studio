#!/usr/bin/env bash
# Staple a notarization ticket to a file, or check that one is stapled,
# retrying a few times: `stapler.sh staple <file>` or `stapler.sh validate <file>`.
#
# Both ask Apple's ticket service for the ticket, and that request sometimes
# fails with "The network connection was lost" on hosted runners. A file with
# no ticket fails every attempt, so retrying keeps the step just as strict
# while riding out a dropped connection.
set -u
action="$1"
file="$2"
case "$action" in
  staple | validate) ;;
  *) echo "usage: stapler.sh staple|validate <file>"; exit 2 ;;
esac
for attempt in 1 2 3 4 5; do
  if xcrun stapler "$action" "$file"; then
    exit 0
  fi
  if [ "$attempt" -lt 5 ]; then
    echo "stapler $action failed (attempt $attempt of 5), trying again in 30 seconds"
    sleep 30
  fi
done
echo "stapler $action failed 5 times for $file"
exit 1
