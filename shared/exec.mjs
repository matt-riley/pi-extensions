// exec.mjs — the `pi.exec` adapter handed to the read-only engines.
//
// Four extensions (affected, architecture, code-search, docs-drift) ran the same
// seven lines: default the timeout, then normalise the streams so a caller that
// prints `stderr` never prints "undefined". One home keeps the timeout from
// drifting per package.

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wrap the host's `pi.exec` as the `{ code, stdout, stderr }` reader the git
 * and inventory helpers expect. `opts.timeout` overrides the default; a stream
 * the host left undefined becomes an empty string.
 * @param {{ exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number, stdout?: string, stderr?: string }> }} pi
 * @returns {(cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function piExec(pi) {
  return async (cmd, args, opts) => {
    const result = await pi.exec(cmd, args, {
      timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
    });
    return {
      code: result.code,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  };
}
