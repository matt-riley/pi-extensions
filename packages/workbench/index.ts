import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installWorkbench } from "./workbench.mjs";

export default function (pi: ExtensionAPI) {
  installWorkbench(pi);
}
