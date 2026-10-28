#!/usr/bin/env bash
# GNU script utility primitives, not a full Linux Node/Pi integration test.
# Uses only an already-cached image; never downloads or installs dependencies.
set -eu
name="pi-jobs-linux-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --rm -i --name "$name" --pull=never --network=none \
  buildpack-deps:bookworm-scm /bin/bash -s <<'LINUX'
set -u
mkfifo /tmp/input
exec 6<>/tmp/input
inner="exec /bin/bash -c 'printf \"%s %s\\n\" \"\$(tty)\" \"\$\$\" >&3; exec 3>&-; test \"\$\$\" -eq \"\$(ps -o pgid= -p \$\$)\" || exit 87; stty rows 25 cols 90; read answer; stty size; printf \"got:%s\\n\" \"\$answer\"; exit 9'"
/bin/bash -c 'exec 4< <(cat); feeder=$!; /usr/bin/script -qefc "$1" /dev/null <&4 4<&-; status=$?; kill "$feeder" 2>/dev/null; exit "$status"' \
  pi-pty "$inner" 3>/tmp/identity </tmp/input >/tmp/output 2>&1 &
wrapper=$!
(sleep 4; kill "$wrapper" 2>/dev/null) & guard=$!
for i in {1..60}; do [ -s /tmp/identity ] && break; sleep .05; done
printf 'native\n' >&6
wait "$wrapper"; result=$?
kill "$guard" 2>/dev/null || true
cat /tmp/output
printf 'script exit status: %s; PTY identity: ' "$result"
cat /tmp/identity
[ "$result" = 9 ] || exit 1
grep -q '25 90' /tmp/output || exit 1
grep -q 'got:native' /tmp/output || exit 1
echo 'ok: GNU PTY input, dimensions, group identity and exit 9 with input still open'
LINUX
