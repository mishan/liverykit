#!/bin/sh
# The README's picture of the editor, taken in a sealed shotbox session so it
# comes out the same each time and nothing opens on the desktop.
#
#   tools/screenshot.sh <livery> <out.png> [view [liverykit options...]]
#
# view is what the editor's link opens on, `view=all&yaw=1.0&pitch=0.25&zoom=0.85`
# by default; the view is uv, 3d, all or cockpit. The options after it go to
# liverykit, such as --profile for a portable livery.
# Needs shotbox (pipx install shotbox), Firefox, and the car's kn5.
set -eu
livery=$1 out=$(realpath -m "$2") view=${3:-view=all&yaw=1.0&pitch=0.25&zoom=0.85}
if [ $# -ge 3 ]; then shift 3; else shift $#; fi
name=liverykit-shot-$$
cd "$(dirname "$0")/.."

shotbox start --name "$name" --net loopback --screen 1600x1000 --a11y >/dev/null
trap 'shotbox stop "$name" >/dev/null 2>&1' EXIT
run() { shotbox --session "$name" "$@"; }

shotbox spawn --session "$name" -- node bin/liverykit.mjs "$livery" "$@" --ui --port 7400 >/dev/null
run wait port 7400 --timeout 60

# Opened from a link rather than steered with the mouse and keyboard: the
# sandbox draws in software GL, a second or more a frame, and input that
# arrives while a frame is drawing lands late or not at all, so no two
# pictures turned the car the same distance.
#
# The view note is a status region, and its announcement is what says the view
# is drawn: the canvas holds still for seconds at a time while the server
# renders, so a stillness wait alone fires with the car half textured.
case $view in
  *view=all*) said='triangles · ' ;;
  *view=cockpit*) said='^[0-9]+ painted surface' ;;
  *view=uv*) said='.' ;;
  *) said='triangles painted by' ;;
esac
run wait announce "$said" --timeout 120 &
drawn=$!
# A fresh profile each time: Firefox's first-run pages and restored sessions
# are the difference between two shots of the same page. Under the session's
# own home, which goes when the session does: made with mktemp in /tmp, 66 of
# them piled up there, 2.4 GB of a tmpfs, and nothing ever removed them.
shotbox spawn --session "$name" -- sh -c 'p=$HOME/firefox; mkdir -p "$p"; exec firefox --kiosk --new-instance --profile "$p" --width 1600 --height 1000 "$1"' sh "http://127.0.0.1:7400/#$view" >/dev/null
wait "$drawn"
# The announcement is not the paint. The first frame holds Firefox's main
# thread for seconds after the note changes, with the screen frozen on
# "rendering…" long enough to pass any stillness wait. So wait for the note
# to repaint; on a machine fast enough to have painted already this times out
# harmlessly.
run wait change --crop 900x60+560+60 --timeout 30 >/dev/null || true
run park
run wait stable 1 --timeout 60
run capture "$out"
