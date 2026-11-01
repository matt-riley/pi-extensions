import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { installFooter } from "./extension.mjs";
import { installUsage } from "./usage.mjs";

export default function (pi: ExtensionAPI) {
  installFooter(pi, { visibleWidth, truncateToWidth });
  installUsage(pi);
}
