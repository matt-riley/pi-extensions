import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { installDecisionRows } from "./rows.mjs";

export default function (pi: ExtensionAPI) {
  installDecisionRows(pi, { truncateToWidth });
}
