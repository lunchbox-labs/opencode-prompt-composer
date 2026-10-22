import { EventEmitter } from "node:events";

interface Options {
  content?: string;
  options?: { name: string; description: string; value: string }[];
  selectedIndex?: number;
}

// Flow tests need the component tree and events; the native PTY tests cover FFI.
export class BoxRenderable extends EventEmitter {
  readonly children: BoxRenderable[] = [];
  readonly config: Options;
  isDestroyed = false;
  constructor(_renderer: unknown, config: Options) {
    super();
    this.config = config;
  }
  add(child: BoxRenderable) {
    this.children.push(child);
  }
  getChildren() {
    return this.children;
  }
  destroyRecursively() {
    for (const child of this.children) {
      child.destroyRecursively();
    }
    this.isDestroyed = true;
    this.emit("destroyed");
    this.removeAllListeners();
  }
}

export class TextRenderable extends BoxRenderable {
  get plainText() {
    return this.config.content ?? "";
  }
}

export class SelectRenderable extends BoxRenderable {
  private selected = this.config.selectedIndex ?? 0;
  get options() {
    return this.config.options ?? [];
  }
  getSelectedIndex() {
    return this.selected;
  }
  setSelectedIndex(index: number) {
    this.selected = index;
    this.emit("selectionChanged", index, this.options[index]);
  }
  selectCurrent() {
    this.emit("itemSelected", this.selected, this.options[this.selected]);
  }
  focus() {}
}

export const SelectRenderableEvents = {
  SELECTION_CHANGED: "selectionChanged",
  ITEM_SELECTED: "itemSelected",
};

export const RenderableEvents = { DESTROYED: "destroyed" };
export const TextAttributes = { BOLD: 1 };
export const MouseButton = { LEFT: 0 };
