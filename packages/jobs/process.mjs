import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

/** script owns the PTY; the extra fd reports its identity before user code runs. */
export function spawnJob({ command, cwd, pty }) {
  const shell = process.platform === "win32" ? "bash" : "/bin/bash";
  let args = ["-c", command];
  if (pty) {
    if (!["darwin", "linux"].includes(process.platform))
      throw new Error("PTY jobs require macOS or Linux with the script utility.");
    const columns = Math.max(1, process.stdout.columns || 100);
    const rows = Math.max(1, process.stdout.rows || 30);
    const inner = [
      "/bin/bash",
      "-c",
      'printf "%s %s\\n" "$(tty)" "$$" >&3; exec 3>&-; stty rows "$1" cols "$2"; shift 2; exec /bin/bash -c "$1"',
      "pi-command",
      String(rows),
      String(columns),
      command,
    ];
    const script =
      process.platform === "darwin"
        ? '/usr/bin/script -qF /dev/null "$@"'
        : '/usr/bin/script -qefc "$1" /dev/null';
    // Node's "pipe" is a socket on macOS; script rejects tcgetattr on it.
    // A real pipe from cat works. Kill that feeder after script exits, or an
    // open input stream would keep the wrapper alive and hide the exit code.
    args = [
      "-c",
      "exec 4< <(cat); feeder=$!; " +
        script +
        ' <&4 4<&-; status=$?; kill "$feeder" 2>/dev/null; exit "$status"',
      "pi-pty",
      // GNU script uses sh -c: exec keeps the reported PID its PTY process-group leader.
      ...(process.platform === "darwin" ? inner : ["exec " + inner.map(quote).join(" ")]),
    ];
  }
  return spawn(shell, args, {
    cwd,
    env: pty ? { ...process.env, TERM: process.env.TERM || "xterm-256color" } : process.env,
    detached: process.platform !== "win32",
    stdio: pty ? ["pipe", "pipe", "pipe", "pipe"] : "pipe",
  });
}

export async function resizePty(tty, columns, rows) {
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 1000 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 1000
  )
    throw new Error("Terminal dimensions must be integers from 1 to 1000.");
  await exec(
    "stty",
    [
      process.platform === "darwin" ? "-f" : "-F",
      tty,
      "rows",
      String(rows),
      "cols",
      String(columns),
    ],
    { timeout: 2000 },
  );
}
