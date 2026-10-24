import { stripVTControlCharacters } from "node:util";
import { searchItems } from "./catalog.mjs";

export const safe = (text) => stripVTControlCharacters(String(text)).replace(/\p{Cc}/gu, "");

/** State belongs to the flow, not a component: returning restores query and identity. */
export function pick(ctx, title, items, state, { Input, SelectList, truncateToWidth }) {
  return ctx.ui.custom(
    (tui, theme, keys, done) => {
      const input = new Input();
      input.setValue(state.query ?? "");
      let matches, list;
      const remember = () => {
        state.selected = matches[Number(list.getSelectedItem()?.value)]?.id;
      };
      const refresh = () => {
        matches = searchItems(items, input.getValue());
        state.query = input.getValue();
        list = new SelectList(
          matches.map((item, index) => ({
            value: String(index),
            label: safe((item.group ? item.group + " · " : "") + item.label),
            description: safe(item.description ?? ""),
          })),
          10,
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        );
        list.setSelectedIndex(
          Math.max(
            0,
            matches.findIndex((item) => item.id === state.selected),
          ),
        );
        remember();
        list.onSelectionChange = remember;
        list.onSelect = (item) => {
          remember();
          done(matches[Number(item.value)]);
        };
        list.onCancel = () => done(undefined);
      };
      refresh();
      return {
        get focused() {
          return input.focused;
        },
        set focused(value) {
          input.focused = value;
        },
        render(width) {
          list.maxVisible = Math.max(1, Math.min(12, tui.terminal.rows - 10));
          return [
            theme.fg("accent", safe(title)),
            ...input.render(width),
            theme.fg("dim", matches.length + " matches — type to filter"),
            ...list.render(width),
            theme.fg("dim", "↑↓ select · Enter confirm · Esc cancel"),
          ].map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        handleInput(data) {
          if (
            keys.matches(data, "tui.select.pageUp") ||
            keys.matches(data, "tui.select.pageDown")
          ) {
            const direction = keys.matches(data, "tui.select.pageUp") ? -1 : 1;
            list.setSelectedIndex(
              Math.max(
                0,
                Math.min(
                  matches.length - 1,
                  Number(list.getSelectedItem()?.value ?? 0) + direction * list.maxVisible,
                ),
              ),
            );
            remember();
          } else if (
            ["up", "down", "confirm", "cancel"].some((action) =>
              keys.matches(data, "tui.select." + action),
            )
          ) {
            list.handleInput(data);
          } else {
            const before = input.getValue();
            input.handleInput(data);
            if (input.getValue() !== before) refresh();
          }
          tui.requestRender();
        },
        invalidate() {
          input.invalidate();
          list.invalidate();
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" } },
  );
}

/** No editor or write callback: input can only navigate, hand off, or close. */
export function preview(ctx, item, text, state, { ScrollView, matchesKey, truncateToWidth }) {
  return ctx.ui.custom(
    (tui, theme, keys, done) => {
      const lines = text
        .replace(/\p{Cc}/gu, (char) =>
          char === "\n" ? char : char === "\t" ? "    " : JSON.stringify(char).slice(1, -1),
        )
        .split("\n");
      const body = {
        render: (width) =>
          lines.map((line) =>
            theme.fg(
              line.startsWith("+")
                ? "success"
                : line.startsWith("-")
                  ? "error"
                  : line.startsWith("@@")
                    ? "accent"
                    : "text",
              truncateToWidth(line, Math.max(1, width)),
            ),
          ),
        invalidate() {},
      };
      const view = new ScrollView(body);
      let height = 1,
        initialized = false;
      return {
        render(width) {
          height = Math.max(1, Math.min(24, tui.terminal.rows - 9));
          view.updateLayout(lines.length, height, () => tui.requestRender());
          if (!initialized) {
            view.scrollTo(state.offset ?? 0);
            initialized = true;
          }
          state.offset = view.scrollTop;
          return [
            theme.fg(
              "accent",
              "[" + item.scope + "] " + safe(JSON.stringify(item.file)) + " — read-only",
            ),
            theme.fg("dim", "Line " + (view.scrollTop + 1) + "/" + lines.length),
            ...view.render(width).slice(view.scrollTop, view.scrollTop + height),
            theme.fg("dim", "↑↓ scroll · PgUp/PgDn · Home/End"),
            theme.fg("dim", "←/→ file · e Neovim · i reference · Esc list"),
          ].map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        handleInput(data) {
          if (keys.matches(data, "tui.select.cancel")) return done(undefined);
          if (matchesKey(data, "right")) return done("next");
          if (matchesKey(data, "left")) return done("previous");
          if (matchesKey(data, "e")) return done("neovim");
          if (matchesKey(data, "i")) return done("reference");
          if (keys.matches(data, "tui.select.up")) view.scrollBy(-1);
          else if (keys.matches(data, "tui.select.down")) view.scrollBy(1);
          else if (keys.matches(data, "tui.select.pageUp")) view.scrollBy(-height);
          else if (keys.matches(data, "tui.select.pageDown")) view.scrollBy(height);
          else if (matchesKey(data, "home")) view.scrollToStart();
          else if (matchesKey(data, "end")) view.scrollToEnd();
          state.offset = view.scrollTop;
          tui.requestRender();
        },
        invalidate() {
          view.invalidate();
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" } },
  );
}
