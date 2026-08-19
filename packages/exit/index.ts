// /exit — alias for the built-in /quit command.
// Requests a graceful shutdown (emits session_shutdown, then exits),
// exactly as /quit does.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Exit pi (alias for /quit)",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
}
