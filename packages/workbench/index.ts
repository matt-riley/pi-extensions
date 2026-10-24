import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, ScrollView, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { installWorkbench } from "./workbench.mjs";

export default function (pi: ExtensionAPI) {
  installWorkbench(pi, { Input, SelectList, ScrollView, matchesKey, truncateToWidth });
}
