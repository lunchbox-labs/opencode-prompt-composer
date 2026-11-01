import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import type { TuiDialogSelectProps } from "@opencode-ai/plugin/tui";
import {
  BoxRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TextRenderable,
} from "./fixed-menu-runtime.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@opentui/core" &&
      /\/(?:fixed-menu|text-viewer)\.(?:ts|js)$/.test(context.parentURL ?? "")
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
  renderer: Object.assign(new EventEmitter(), { height: 40 }),
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

/** The title and complete text shown by a scrollable text viewer. */
export function textViewerView(
  element: unknown,
): { title: string; message: string } | undefined {
  if (!(element instanceof BoxRenderable)) {
    return;
  }
  const children = element.getChildren();
  const scroll = children.find((child) => child instanceof ScrollBoxRenderable);
  if (scroll === undefined) {
    return;
  }
  const title = children.find((child) => child instanceof TextRenderable);
  const text = scroll.getChildren()[0]?.getChildren()[0];
  if (title === undefined || !(text instanceof TextRenderable)) {
    throw new Error("Text viewer is missing its title or text");
  }
  return { title: title.plainText, message: text.plainText };
}

/** Plugin-rendered dialogs in the shape tests read from native dialogs. */
export function dialogView(element: unknown) {
  return textViewerView(element) ?? fixedMenuView(element);
}

export function destroyFixedMenu(element: unknown) {
  if (element instanceof BoxRenderable) {
    element.destroyRecursively();
  }
}
