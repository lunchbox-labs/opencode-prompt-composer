import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

// The host dialog starts a quarter down the screen; its padding plus this view's
// title, footer, gaps and a bottom margin take the remaining rows.
const chromeRows = 7;

/** Render read-only text in a keyboard-scrollable box inside the host's dialog frame. */
export async function createTextViewer(api: TuiPluginApi) {
  // OpenCode supplies its shared runtime; importing this entrypoint stays Node-safe.
  const {
    BoxRenderable,
    RenderableEvents,
    ScrollBoxRenderable,
    TextAttributes,
    TextRenderable,
  } = await import("@opentui/core");

  return (props: {
    title: string;
    text: string;
  }): ReturnType<TuiPluginApi["ui"]["DialogAlert"]> => {
    const { renderer } = api;
    const theme = api.theme.current;
    const rows = () =>
      Math.max(
        1,
        renderer.height - Math.floor(renderer.height / 4) - chromeRows,
      );
    const view = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingX: 2,
      paddingBottom: 1,
      gap: 1,
    });
    view.add(
      new TextRenderable(renderer, {
        content: props.title,
        fg: theme.text,
        attributes: TextAttributes.BOLD,
        selectable: false,
      }),
    );
    const scroll = new ScrollBoxRenderable(renderer, {
      // Logical lines until the wrapped body reports its height.
      height: Math.min(rows(), props.text.split("\n").length),
      flexShrink: 0,
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: {
          backgroundColor: theme.backgroundElement,
          foregroundColor: theme.border,
        },
      },
    });
    const body = new BoxRenderable(renderer, {});
    // Short text keeps a compact dialog; long text scrolls within the terminal.
    const fit = () => {
      if (!scroll.isDestroyed) {
        scroll.height = Math.max(1, Math.min(rows(), body.height));
      }
    };
    body.onSizeChange = fit;
    body.add(
      new TextRenderable(renderer, {
        content: props.text,
        fg: theme.text,
        wrapMode: "word",
      }),
    );
    scroll.add(body);
    view.add(scroll);
    view.add(
      new TextRenderable(renderer, {
        content: "↑/↓ scroll · pgup/pgdn page · home/end · esc back",
        fg: theme.textMuted,
        selectable: false,
      }),
    );
    renderer.on("resize", fit);
    // The session's global paging keys close dialogs; a later layer on the
    // focused box takes precedence, as the host's own DialogSelect does.
    const unbind = api.keymap.registerLayer({
      target: scroll,
      targetMode: "focus",
      bindings: [
        { key: "pageup", cmd: () => scroll.scrollBy(-1 / 2, "viewport") },
        { key: "pagedown", cmd: () => scroll.scrollBy(1 / 2, "viewport") },
        { key: "home", cmd: () => scroll.scrollBy(-1, "content") },
        { key: "end", cmd: () => scroll.scrollBy(1, "content") },
      ],
    });
    // Match native DialogSelect: Escape first queues the host's previous-input focus.
    const focus = setTimeout(() => {
      if (!scroll.isDestroyed && !api.lifecycle.signal.aborted) {
        scroll.focus();
      }
    }, 1);
    const dispose = () => view.destroyRecursively();
    api.lifecycle.signal.addEventListener("abort", dispose, { once: true });
    view.on(RenderableEvents.DESTROYED, () => {
      clearTimeout(focus);
      renderer.off("resize", fit);
      unbind();
      api.lifecycle.signal.removeEventListener("abort", dispose);
    });
    // OpenTUI accepts Renderable children; Solid's shared JSX type still names DOM nodes.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenTUI's reconciler inserts Renderable instances directly.
    return view as unknown as ReturnType<TuiPluginApi["ui"]["DialogAlert"]>;
  };
}
