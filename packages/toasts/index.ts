import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { installToasts } from "./extension.mjs";

export default function (pi: ExtensionAPI) {
  installToasts(pi, { visibleWidth, truncateToWidth });
}
