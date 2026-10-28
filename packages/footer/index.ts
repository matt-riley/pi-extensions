import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { installFooter } from "./extension.mjs";

export default function (pi: ExtensionAPI) {
  installFooter(pi, { visibleWidth, truncateToWidth });
}
