import type {
  TuiDialogSelectProps,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";

/** Render small, fixed choices inside the host's existing dialog frame. */
export async function createFixedMenu(api: TuiPluginApi) {
  // OpenCode supplies its shared runtime; importing this entrypoint stays Node-safe.
  const {
    BoxRenderable,
    RenderableEvents,
    SelectRenderable,
    SelectRenderableEvents,
    TextAttributes,
    TextRenderable,
  } = await import("@opentui/core");

  return (
    props: TuiDialogSelectProps<string>,
  ): ReturnType<TuiPluginApi["ui"]["DialogSelect"]> => {
    const { renderer } = api;
    const theme = api.theme.current;
    const menu = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingX: 2,
      paddingBottom: 1,
      gap: 1,
    });
    menu.add(
      new TextRenderable(renderer, {
        content: props.title,
        fg: theme.text,
        attributes: TextAttributes.BOLD,
        selectable: false,
      }),
    );
    const options = props.options;
    const showDescription = options.some(
      (option) => option.description !== undefined,
    );
    const rowHeight = showDescription ? 2 : 1;
    const select = new SelectRenderable(renderer, {
      width: "100%",
      height: Math.max(1, options.length * rowHeight),
      options: options.map((option) => ({
        name: option.title,
        description: option.description ?? "",
        value: option.value,
      })),
      selectedIndex: Math.max(
        0,
        options.findIndex((option) => option.value === props.current),
      ),
      showDescription,
      wrapSelection: true,
      backgroundColor: theme.backgroundPanel,
      focusedBackgroundColor: theme.backgroundPanel,
      textColor: theme.text,
      focusedTextColor: theme.text,
      descriptionColor: theme.textMuted,
      selectedBackgroundColor: theme.primary,
      selectedTextColor: theme.selectedListItemText,
      selectedDescriptionColor: theme.selectedListItemText,
      onMouseUp(event) {
        if (event.button !== 0) {
          return;
        }
        event.stopPropagation();
        const index = Math.floor((event.y - select.y) / rowHeight);
        if (index >= 0 && index < options.length) {
          select.setSelectedIndex(index);
          select.selectCurrent();
        }
      },
    });
    select.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      const option = options.at(index);
      if (
        option !== undefined &&
        !menu.isDestroyed &&
        !api.lifecycle.signal.aborted
      ) {
        props.onMove?.(option);
      }
    });
    select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
      const option = options.at(index);
      if (
        option !== undefined &&
        option.disabled !== true &&
        !menu.isDestroyed &&
        !api.lifecycle.signal.aborted
      ) {
        option.onSelect?.();
        props.onSelect?.(option);
      }
    });
    menu.add(select);
    menu.add(
      new TextRenderable(renderer, {
        content: "↑/↓ move · enter select · esc back",
        fg: theme.textMuted,
        selectable: false,
      }),
    );
    // Match native DialogSelect: Escape first queues the host's previous-input focus.
    const focus = setTimeout(() => {
      if (!select.isDestroyed && !api.lifecycle.signal.aborted) {
        select.focus();
      }
    }, 1);
    const dispose = () => menu.destroyRecursively();
    api.lifecycle.signal.addEventListener("abort", dispose, { once: true });
    menu.on(RenderableEvents.DESTROYED, () => {
      clearTimeout(focus);
      api.lifecycle.signal.removeEventListener("abort", dispose);
    });
    // OpenTUI accepts Renderable children; Solid's shared JSX type still names DOM nodes.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenTUI's reconciler inserts Renderable instances directly.
    return menu as unknown as ReturnType<TuiPluginApi["ui"]["DialogSelect"]>;
  };
}
