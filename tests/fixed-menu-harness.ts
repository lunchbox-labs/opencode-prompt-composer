import { registerHooks } from "node:module";
import type { TuiDialogSelectProps } from "@opencode-ai/plugin/tui";
import {
  BoxRenderable,
  SelectRenderable,
  TextRenderable,
} from "./fixed-menu-runtime.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@opentui/core" &&
      /\/fixed-menu\.(?:ts|js)$/.test(context.parentURL ?? "")
    ) {
      return {
        url: new URL("./fixed-menu-runtime.ts", import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

export const fixedMenuApi = {
  renderer: {},
  theme: {
    current: {
      primary: "#abcdef",
      text: "#ffffff",
      textMuted: "#888888",
      selectedListItemText: "#000000",
      backgroundPanel: "#222222",
    },
  },
};

export function fixedMenuView(
  element: unknown,
): (TuiDialogSelectProps<string> & { renderFilter: false }) | undefined {
  if (!(element instanceof BoxRenderable)) {
    return;
  }
  const children = element.getChildren();
  const title = children.find((child) => child instanceof TextRenderable);
  const select = children.find((child) => child instanceof SelectRenderable);
  if (title === undefined || select === undefined) {
    throw new Error("Fixed menu is missing its title or list");
  }
  const options = select.options.map((option) => ({
    title: option.name,
    value: option.value,
    ...(option.description === "" ? {} : { description: option.description }),
  }));
  return {
    title: title.plainText,
    options,
    renderFilter: false,
    get current() {
      return options[select.getSelectedIndex()]?.value;
    },
    onMove(option) {
      select.setSelectedIndex(
        options.findIndex((item) => item.value === option.value),
      );
    },
    onSelect(option) {
      select.setSelectedIndex(
        options.findIndex((item) => item.value === option.value),
      );
      select.selectCurrent();
    },
  };
}

export function destroyFixedMenu(element: unknown) {
  if (element instanceof BoxRenderable) {
    element.destroyRecursively();
  }
}
