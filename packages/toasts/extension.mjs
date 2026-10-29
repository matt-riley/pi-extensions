// Top-right toast overlay: reroute extension ctx.ui.notify in TUI mode only.
import { createToastQueue, createToastStack } from "./toast.mjs";

const WIDGET_KEY = "toasts:bridge";
const MIN_WIDTH = 30;
const MIN_HEIGHT = 8;

/** @param {Record<string, string | undefined>} env */
export function readToastSettings(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    capture: env.PI_TOAST_CAPTURE !== "0",
    width: num("PI_TOAST_WIDTH", 44),
    maxVisible: Math.max(1, Math.floor(num("PI_TOAST_MAX_VISIBLE", 3))),
    timeout: {
      info: num("PI_TOAST_TIMEOUT_INFO", 4000),
      warning: num("PI_TOAST_TIMEOUT_WARNING", 6000),
      error: num("PI_TOAST_TIMEOUT_ERROR", 8000),
    },
  };
}

/** @param {import("./toast.mjs").Severity | undefined} severity */
export function timeoutMs(severity, settings) {
  if (severity === "error") return settings.timeout.error;
  if (severity === "warning") return settings.timeout.warning;
  return settings.timeout.info;
}

export function overlayVisible(w, h) {
  return w >= MIN_WIDTH && h >= MIN_HEIGHT;
}

/** @param {{ show(text: string, severity?: import("./toast.mjs").Severity, ms?: number): void }} queue */
export function wrapNotify(queue, settings) {
  return (message, type) => {
    const severity = type === "warning" || type === "error" ? type : "info";
    queue.show(message, severity, timeoutMs(severity, settings));
  };
}

export function restoreNotify(ui, original, installed) {
  if (ui && installed && ui.notify === installed && original) ui.notify = original;
}

/**
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 * @param {{ visibleWidth: Function, truncateToWidth: Function }} piTui
 */
export function installToasts(pi, piTui) {
  /** @type {import("@earendil-works/pi-tui").TUI | undefined} */
  let tui;
  let stack;
  let queue;
  /** @type {import("@earendil-works/pi-tui").OverlayHandle | undefined} */
  let handle;
  /** @type {import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined} */
  let ui;
  /** @type {((title: string, level?: string) => void) | undefined} */
  let original;
  /** @type {((title: string, level?: string) => void) | undefined} */
  let installed;

  const settings = readToastSettings();

  const overlayOptions = () => ({
    anchor: "top-right",
    width: settings.width,
    margin: { top: 1, right: 1 },
    nonCapturing: true,
    visible: overlayVisible,
  });

  function teardown() {
    queue?.dispose();
    queue = undefined;
    handle?.hide();
    handle = undefined;
    restoreNotify(ui, original, installed);
    ui = installed = original = undefined;
    tui = stack = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    teardown();
    if (ctx.mode !== "tui") return;

    ctx.ui.setWidget(WIDGET_KEY, (t) => {
      tui = t;
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    if (!tui) return;

    const theme = ctx.ui.theme;
    stack = createToastStack((token, text) => theme?.fg?.(token, text) ?? text, piTui);
    queue = createToastQueue(
      (toasts) => {
        if (!tui || !stack) return;
        stack.setToasts(toasts);
        if (toasts.length === 0) {
          handle?.hide();
          handle = undefined;
        } else if (!handle) {
          handle = tui.showOverlay(stack, overlayOptions());
        }
        tui.requestRender();
      },
      { maxVisible: settings.maxVisible },
    );

    if (settings.capture) {
      ui = ctx.ui;
      original = ctx.ui.notify?.bind(ctx.ui);
      installed = wrapNotify(queue, settings);
      ctx.ui.notify = installed;
    }
  });

  pi.on("session_shutdown", () => teardown());
}
