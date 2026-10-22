import type {
  TuiDialogSelectProps,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";

type Render = () => ReturnType<TuiPluginApi["ui"]["DialogAlert"]>;
const backValue = "\u0000back";

/** Retain parent views while using V1's replacement-only dialog API. */
export function dialogNavigation(api: TuiPluginApi) {
  let frames: Render[] = [];
  let revision = 0;
  let replacing = false;
  let visible = false;

  const reset = () => {
    frames = [];
    visible = false;
    revision++;
  };
  api.lifecycle.signal.addEventListener("abort", reset, { once: true });

  // Bind asynchronous picker results to the view and connection that requested them.
  const checkpoint = () => {
    const active = revision;
    const client = api.client;
    const { directory, worktree } = api.state.path;
    const route = api.route.current;
    const name = route.name;
    const sessionID = name === "session" ? route.params?.sessionID : undefined;
    return () => {
      const current = api.route.current;
      return (
        !api.lifecycle.signal.aborted &&
        active === revision &&
        client === api.client &&
        directory === api.state.path.directory &&
        worktree === api.state.path.worktree &&
        current.name === name &&
        (current.name !== "session" || current.params?.sessionID === sessionID)
      );
    };
  };

  const display = (render: Render) => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    const client = api.client;
    const { directory, worktree } = api.state.path;
    const route = api.route.current;
    const name = route.name;
    const sessionID = name === "session" ? route.params?.sessionID : undefined;
    const active = ++revision;
    replacing = true;
    try {
      api.ui.dialog.replace(render, () => {
        if (replacing || active !== revision) {
          return;
        }
        visible = false;
        frames.pop();
        const parent = frames.at(-1);
        const closed = ++revision;
        // Native Escape/OK/Cancel clears the dialog after this callback returns.
        queueMicrotask(() => {
          if (closed !== revision) {
            return;
          }
          const current = api.route.current;
          if (
            api.lifecycle.signal.aborted ||
            client !== api.client ||
            directory !== api.state.path.directory ||
            worktree !== api.state.path.worktree ||
            api.ui.dialog.open ||
            current.name !== name ||
            (current.name === "session" &&
              current.params?.sessionID !== sessionID)
          ) {
            reset();
            return;
          }
          if (parent !== undefined) {
            display(parent);
          }
        });
      });
      visible = true;
    } finally {
      replacing = false;
    }
  };
  const show = (render: Render, root = false) => {
    if (api.lifecycle.signal.aborted) {
      return;
    }
    if (root) {
      reset();
    }
    frames.push(render);
    display(render);
  };
  const close = () => {
    reset();
    api.ui.dialog.clear();
  };
  const back = () => {
    if (frames.length < 2) {
      close();
      return;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (parent !== undefined) {
      display(parent);
    }
  };
  const select = (
    props: TuiDialogSelectProps<string>,
    render: (props: TuiDialogSelectProps<string>) => ReturnType<Render> = api.ui
      .DialogSelect,
  ) => {
    let selected = props.current;
    return () => {
      const check = checkpoint();
      return render({
        ...props,
        get current() {
          return selected;
        },
        get options() {
          return frames.length > 1
            ? [
                ...props.options,
                {
                  title: "← Back",
                  value: backValue,
                  description: "Return to the previous view",
                  category: "Navigation",
                  footer: "esc",
                },
              ]
            : props.options;
        },
        onMove: (option) => {
          if (!check()) {
            return;
          }
          if (option.value !== backValue) {
            selected = option.value;
          }
          props.onMove?.(option);
        },
        onSelect: (option) => {
          if (!check()) {
            return;
          }
          if (option.value === backValue) {
            back();
            return;
          }
          selected = option.value;
          return props.onSelect?.(option);
        },
      });
    };
  };
  const menu = (
    props: TuiDialogSelectProps<string>,
    root = false,
    render?: (props: TuiDialogSelectProps<string>) => ReturnType<Render>,
  ) => show(select(props, render), root);
  const alert = (props: Parameters<TuiPluginApi["ui"]["DialogAlert"]>[0]) =>
    show(() => api.ui.DialogAlert(props));
  return {
    show,
    menu,
    select,
    alert,
    back,
    close,
    reset,
    checkpoint,
    refresh() {
      const current = frames.at(-1);
      if (current !== undefined) {
        display(current);
      }
    },
    get canGoBack() {
      return frames.length > 1;
    },
    get active() {
      return visible && frames.length > 0 && !api.lifecycle.signal.aborted;
    },
  };
}
