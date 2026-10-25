import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ScrollView, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { installJobs } from "./extension.mjs";

export default function (pi: ExtensionAPI) {
  installJobs(pi, { ScrollView, matchesKey, truncateToWidth });
}
