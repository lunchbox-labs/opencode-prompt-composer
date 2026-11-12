import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  exerciseConfigEditor,
  exercisePromptViewer,
} from "./native-editors.ts";
import { corePackage, nativeHost } from "./hosts.ts";
import { resolveNativeVersion, verifyNativeVersion } from "./native-host.ts";
import { exerciseNativeTerminal, viewerCommands } from "./native-terminal.ts";
import { prepareRipgrep } from "./native-ripgrep.ts";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run native tests through npm");
const host = nativeHost();
const product = host.profile.name;
const configDirectory = host.projectDirectory;
// The config-first coexistence leg pairs this plugin with the OpenCode-only
// config-composer package, so it runs on the OpenCode host only.
assert.ok(
  host.id === "opencode" || process.env.CONFIG_COMPOSER_DIR === undefined,
  "The config-first leg runs on the OpenCode host only",
);

test(
  `${product}: npm-registered native hooks retain snippets until process restart and compose native skills`,
  { timeout: 600_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "prompt-native-")),
    );
    let stopHost = async () => {};
    let closeModel = () => {};
    t.after(async () => {
      await stopHost();
      closeModel();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        [
          "path",
          "systemroot",
          "windir",
          "comspec",
          "pathext",
          "https_proxy",
          "http_proxy",
          "ssl_cert_file",
          "node_extra_ca_certs",
        ].includes(key.toLowerCase())
      ) {
        env[key] = value;
      }
    }
    Object.assign(env, {
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      npm_config_cache: join(root, "npm-cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      [`${host.envPrefix}_TEST_HOME`]: root,
      [`${host.envPrefix}_DB`]: join(root, "db.sqlite"),
      [`${host.envPrefix}_DISABLE_AUTOUPDATE`]: "1",
      [`${host.envPrefix}_DISABLE_MODELS_FETCH`]: "1",
      [`${host.envPrefix}_DISABLE_DEFAULT_PLUGINS`]: "true",
      [`${host.envPrefix}_EXPERIMENTAL_DISABLE_FILEWATCHER`]: "true",
      ...host.extraEnv,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    });
    await mkdir(join(root, "home"), { recursive: true });
    const installEnv = {
      ...process.env,
      HOME: env.HOME,
      USERPROFILE: env.USERPROFILE,
      npm_config_cache: env.npm_config_cache,
    };
    const testSupport = JSON.parse(await readFile(host.support, "utf8")) as {
      range: string;
      floor: string;
    };
    const range = testSupport.range;
    verifyNativeVersion(product, testSupport.floor, range);
    const lane = process.env[host.versionVariable];
    const version = await resolveNativeVersion({
      product,
      cliPackage: host.cliPackage,
      npm,
      range,
      cache: join(root, "metadata-cache"),
      env: installEnv,
      signal: t.signal,
      requested: lane === "floor" ? testSupport.floor : lane,
    });
    t.diagnostic(
      `Native ${product} ${version}; tested ${product} range=${range}; lane=${lane ?? "latest-compatible"}`,
    );
    const name = host.platformPackage(process.platform);
    // Install the exact canonical release into a fresh prefix. Missing platform
    // artifacts are failures; never silently fall back to an older host.
    await execute(
      process.execPath,
      [
        npm,
        "install",
        "--prefix",
        join(root, "host"),
        "--no-audit",
        "--no-fund",
        `${name}@${version}`,
      ],
      { env: installEnv, timeout: 120_000, signal: t.signal },
    );
    const binary = join(
      root,
      "host/node_modules",
      name,
      "bin",
      process.platform === "win32" ? `${host.binary}.exe` : host.binary,
    );
    const actual = (
      await execute(binary, ["--version"], {
        env,
        timeout: 30_000,
        signal: t.signal,
      })
    ).stdout.trim();
    verifyNativeVersion(product, version, range, actual);
    await prepareRipgrep(root, env, t.signal);
    // The adapter depends on core at the same version, so both are packed and
    // served; npm packs workspaces in their declared order, core first.
    const packed = await execute(
      process.execPath,
      [
        npm,
        "pack",
        "--workspace",
        corePackage.workspace,
        "--workspace",
        host.workspace,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        root,
      ],
      { cwd: resolve("."), env: installEnv, timeout: 60_000, signal: t.signal },
    );
    const [coreTarball, pluginTarball] = (
      JSON.parse(packed.stdout) as { name: string; filename: string }[]
    ).map(({ filename }) => join(root, filename));
    const install = join(root, "installed");
    await execute(
      process.execPath,
      [
        npm,
        "install",
        "--prefix",
        install,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        coreTarball,
        pluginTarball,
      ],
      { env: installEnv, timeout: 120_000, signal: t.signal },
    );
    const plugin = join(install, "node_modules", host.packageName);
    const project = join(root, "project");
    const shared = join(root, "config", host.profile.globalDirectory);
    for (const path of [
      join(project, `${configDirectory}/prompts/review`),
      join(project, `${configDirectory}/agents`),
      join(project, `${configDirectory}/commands`),
      join(project, `${configDirectory}/skills/evidence`),
      join(shared, "prompts/review"),
      join(shared, "prompts/personal"),
    ]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(join(shared, "prompts/review/body.md"), "Shared");
    await writeFile(
      join(project, `${configDirectory}/prompts/review/body.md`),
      "Project {{include:review/nested.txt}}",
    );
    await writeFile(
      join(project, `${configDirectory}/prompts/review/nested.txt`),
      "evidence",
    );
    const skillOnlyPath = join(
      project,
      `${configDirectory}/prompts/review/skill.txt`,
    );
    const deletedPath = join(
      project,
      `${configDirectory}/prompts/review/deleted.txt`,
    );
    await writeFile(skillOnlyPath, "Skill-only original");
    await writeFile(deletedPath, "Deleted original");
    await writeFile(
      join(shared, "prompts/review/override.txt"),
      "Global original",
    );
    const agentPath = join(project, `${configDirectory}/agents/review.md`);
    // The project agent offers optional personal guidance from the global
    // prompts directory. The snippet is added only before the host restarts.
    const personalPath = join(shared, "prompts/personal/review.md");
    const agentBody =
      "Use evidence.\n\nReview {{include:review/body.md}}\n\nState uncertainty.\n{{include?:personal/review.md}}";
    const agentText = `---\ndescription: Review changes\nmode: primary\n---\n${agentBody}`;
    await writeFile(agentPath, agentText);
    const helperPath = join(project, `${configDirectory}/agents/helper.md`);
    const helperText =
      "---\ndescription: Optional helper\nmode: subagent\ndisable: true\n---\nHelp {{include:review/body.md}}\n\nState uncertainty.\n\nHelper rule.";
    await writeFile(helperPath, helperText);
    const buildPath = join(project, `${configDirectory}/agents/build.md`);
    const buildText =
      "---\ndescription: Custom build instructions\nmode: primary\n---\nBuild override {{include:review/body.md}}";
    await writeFile(buildPath, buildText);
    await writeFile(
      join(project, `${configDirectory}/commands/check.md`),
      "---\ndescription: Native command\nagent: review\nsubtask: true\n---\nCheck {{include:review/body.md}} $ARGUMENTS \\{{include:literal.md}}",
    );
    const skillDirectory = join(project, `${configDirectory}/skills/evidence`);
    const skillBody = [
      "Skill {{include:review/body.md}}",
      "{{include:review/skill.txt}}",
      "{{include:review/deleted.txt}}",
      "{{include:review/override.txt}}",
      "\\{{include:literal.md}}",
    ].join("\n");
    const skillText = `---\nname: evidence\ndescription: Evidence checklist\n---\n${skillBody}`;
    await writeFile(join(skillDirectory, "SKILL.md"), skillText);
    // Colons are not valid in Windows filenames; unit tests cover Windows-shaped
    // wrapper metadata too. POSIX native loading proves filenames remain literal.
    const skillFile = join(
      skillDirectory,
      process.platform === "win32" ? "reference.txt" : "{{include:wrapper.md}}",
    );
    await writeFile(skillFile, "Sampled filename, not prompt content.");
    const obsoletePath = join(
      project,
      `${configDirectory}/prompt-composer.jsonc`,
    );
    const obsoleteText = "{ malformed obsolete policy: ignored";
    await writeFile(obsoletePath, obsoleteText);
    // Serve both packed packages under their real npm identities.
    const served = await Promise.all(
      [
        { file: pluginTarball, directory: plugin, path: "/plugin.tgz" },
        {
          file: coreTarball,
          directory: join(install, "node_modules", corePackage.packageName),
          path: "/core.tgz",
        },
      ].map(async ({ file, directory, path }) => ({
        path,
        tarball: await readFile(file),
        manifest: JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        ) as { name: string; version: string },
      })),
    );
    const [{ manifest }] = served;
    let registry = "";
    let tarballRequests = 0;
    const received: string[] = [];
    const modelServer = createServer((request, response) => {
      const url = decodeURIComponent(request.url ?? "");
      const packument = served.find(
        (entry) => url === `/${entry.manifest.name}`,
      );
      if (packument !== undefined) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            name: packument.manifest.name,
            "dist-tags": { latest: packument.manifest.version },
            versions: {
              [packument.manifest.version]: {
                ...packument.manifest,
                dist: { tarball: `${registry}${packument.path}` },
              },
            },
          }),
        );
        return;
      }
      const download = served.find((entry) => request.url === entry.path);
      if (download !== undefined) {
        if (download.path === "/plugin.tgz") {
          tarballRequests++;
        }
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(download.tarball);
        return;
      }
      let text = "";
      request.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      request.on("end", () => {
        received.push(text);
        const toolReturned = text.includes('"role":"tool"');
        const slashRequested = text.includes(
          "Skill {{include:review/body.md}}",
        );
        const finished = toolReturned || slashRequested;
        const base = {
          id: "fixture",
          model: "fixture",
          created: 1,
          object: "chat.completion.chunk",
        };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = finished
          ? { role: "assistant", content: "Verified." }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "skill-call",
                  type: "function",
                  function: { name: "skill", arguments: '{"name":"evidence"}' },
                },
              ],
            };
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    t.signal.throwIfAborted();
    modelServer.listen(0, "127.0.0.1");
    await once(modelServer, "listening");
    closeModel = () => {
      modelServer.closeAllConnections();
      modelServer.close();
    };
    const address = modelServer.address();
    assert.ok(address !== null && typeof address !== "string");
    const configPlugin = process.env.CONFIG_COMPOSER_DIR;
    // Retain the package's real npm identity. Only this scope uses the local
    // registry; production dependencies still resolve through the normal registry.
    registry = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(root, "home/.npmrc"),
      `@lunchbox-labs:registry=${registry}\n`,
    );
    const npmPlugin = `${manifest.name}@${manifest.version}`;
    const plugins =
      configPlugin === undefined ? [npmPlugin] : [configPlugin, npmPlugin];
    await writeFile(
      join(shared, host.configFile),
      JSON.stringify({
        plugin: plugins,
        ...host.extraConfig,
        model: "fixture/model",
        default_agent: "review",
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fixture",
            options: {
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "test-only",
            },
            models: {
              model: {
                name: "Fixture",
                limit: { context: 32000, output: 1024 },
              },
            },
          },
        },
        permission: { skill: "allow" },
      }),
    );
    if (configPlugin !== undefined) {
      await writeFile(
        join(project, `${configDirectory}/config-composer.jsonc`),
        JSON.stringify({
          componentGroups: { review: { agents: ["review"] } },
          profiles: {
            work: {
              layers: [{ componentGroup: "review" }],
              agentAvailability: { helper: true },
            },
          },
          activeProfiles: ["work"],
          defaults: {
            agents: {
              model: "fixture/model",
              parameters: { temperature: 0.4 },
            },
          },
        }),
      );
    }
    // Match the native test harness: preinstall the genuine pinned SDK in each
    // config directory, avoiding platform-dependent cold dependency bootstrap.
    for (const directory of [shared, join(project, configDirectory)]) {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      await execute(
        process.execPath,
        [
          npm,
          "install",
          "--prefix",
          directory,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          `${host.pluginPackage}@${version}`,
        ],
        { cwd: directory, env: installEnv, timeout: 120_000, signal: t.signal },
      );
    }
    let logs = "";
    let url: string | undefined;
    async function startHost() {
      t.signal.throwIfAborted();
      const child = spawn(
        binary,
        ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
        {
          cwd: project,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logs += chunk.toString();
      });
      stopHost = async () => {
        if (
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          const exited = once(child, "exit");
          if (process.platform === "win32") {
            await execute("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              timeout: 10_000,
            }).catch(() => undefined);
          } else {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              /* Already stopped. */
            }
          }
          await Promise.race([
            exited,
            setTimeout(5000, undefined, { ref: false }),
          ]);
        }
        assert.ok(
          child.exitCode !== null || child.signalCode !== null,
          "The previous native host must exit before a fresh process starts",
        );
      };
      url = undefined;
      for (let n = 0; n < 600; n++) {
        t.signal.throwIfAborted();
        url = /https?:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
        if (url !== undefined) {
          break;
        }
        if (child.exitCode !== null) {
          throw new Error(`${product} exited: ${logs}`);
        }
        await setTimeout(100);
      }
      assert.ok(url !== undefined, `${product} did not start: ${logs}`);
    }
    await startHost();
    async function api(path: string, body?: unknown): Promise<unknown> {
      const response = await fetch(`${url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          [host.directoryHeader]: project,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(60_000)]),
      }).catch((error: unknown) => {
        throw new Error(
          `Native request ${path} failed.\n${logs}\nModel requests: ${received.length}`,
          { cause: error },
        );
      });
      assert.ok(
        response.ok,
        `${path}: ${await response.clone().text()}\n${logs}`,
      );
      return response.json();
    }
    interface Toast {
      title?: string;
      message: string;
      variant: string;
    }
    // Toasts reach a TUI as instance events; collect them the same way.
    async function watchToasts() {
      const toasts: Toast[] = [];
      const stop = new AbortController();
      t.after(() => stop.abort());
      const response = await fetch(`${url}/event`, {
        headers: { [host.directoryHeader]: project },
        signal: AbortSignal.any([t.signal, stop.signal]),
      });
      assert.ok(response.ok && response.body !== null, logs);
      const reading = (async () => {
        let buffered = "";
        for await (const chunk of response.body!.pipeThrough(
          new TextDecoderStream(),
        )) {
          buffered += chunk;
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              continue;
            }
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              properties: Toast;
            };
            if (event.type === "tui.toast.show") {
              const { title, message, variant } = event.properties;
              toasts.push({ title, message, variant });
            }
          }
        }
      })().catch(() => undefined);
      return {
        async until(matches: (toast: Toast) => boolean): Promise<Toast> {
          try {
            for (let attempt = 0; attempt < 200; attempt++) {
              const found = toasts.find(matches);
              if (found !== undefined) {
                return found;
              }
              await setTimeout(50);
            }
            throw new Error(
              `Expected toast was not shown: ${JSON.stringify(toasts)}\n${logs}`,
            );
          } finally {
            stop.abort();
            await reading;
          }
        },
      };
    }
    // The pinned host caches ripgrep initialization globally. Disposing its first
    // instance during a cold download caches an interrupted fiber on Windows.
    // Finish that real dependency before testing instance reloads.
    await writeFile(
      join(project, "readiness.txt"),
      "PromptComposerFixtureReady",
    );
    const readiness = await api("/find?pattern=PromptComposerFixtureReady");
    assert.ok(Array.isArray(readiness) && readiness.length > 0, logs);
    const config = (await api("/config")) as {
      agent: Record<
        string,
        { prompt: string; model?: string; disable?: boolean }
      >;
      command: Record<string, { template: string; subtask: boolean }>;
    };
    async function disposeInstance(
      ready: (current: typeof config) => boolean,
    ): Promise<typeof config> {
      await api("/instance/dispose", {});
      // Disposal acknowledges before teardown finishes. Wait for the fixture's
      // changed native body/availability to prove the replacement is loaded.
      for (let attempt = 0; attempt < 300; attempt++) {
        const current = (await api("/config")) as typeof config;
        if (ready(current)) {
          return current;
        }
        await setTimeout(50);
      }
      throw new Error(
        `Changed prompts were not loaded after disposal.\n${logs}`,
      );
    }
    assert.ok(
      tarballRequests > 0,
      "Native npm loader must fetch the packed candidate",
    );
    assert.equal(
      config.agent.review.prompt,
      "Use evidence.\n\nReview Project evidence\n\nState uncertainty.\n",
      logs,
    );
    assert.equal(
      config.command.check.template,
      "Check Project evidence $ARGUMENTS {{include:literal.md}}",
    );
    assert.equal(config.command.check.subtask, true);
    // The host derives skill commands after config hooks, directly from cached
    // skill content. They do not pass through the skill tool's after hook.
    assert.equal(config.command.evidence, undefined);
    const nativeCommands = (await api("/command")) as {
      name: string;
      source: string;
      template: string;
    }[];
    const skillCommand = nativeCommands.find(
      (command) => command.name === "evidence",
    );
    assert.equal(skillCommand?.source, "skill");
    assert.ok(skillCommand.template.startsWith(skillBody));
    assert.equal(await readFile(obsoletePath, "utf8"), obsoleteText);
    if (configPlugin !== undefined) {
      assert.equal(config.agent.review.model, "fixture/model", logs);
      assert.equal(config.agent.helper.disable, false);
      assert.equal(
        config.agent.helper.prompt,
        "Help Project evidence\n\nState uncertainty.\n\nHelper rule.",
      );
      await exerciseConfigEditor(configPlugin, shared, api);
    }
    await exercisePromptViewer(plugin, api, agentPath).catch(
      (error: unknown) => {
        throw new Error(`Native prompt viewer failed.\n${logs}`, {
          cause: error,
        });
      },
    );
    async function exerciseSkill(expectedBody: string) {
      const before = received.length;
      const session = (await api("/session", {})) as { id: string };
      const message = await api(`/session/${session.id}/message`, {
        agent: "review",
        model: { providerID: "fixture", modelID: "model" },
        parts: [{ type: "text", text: "Load evidence now." }],
      });
      assert.match(JSON.stringify(message), /Verified/);
      const toolMessages = received.slice(before).flatMap((body) =>
        (
          JSON.parse(body) as {
            messages: { role: string; content: string }[];
          }
        ).messages.filter((message) => message.role === "tool"),
      );
      assert.ok(
        toolMessages.some(
          (message) =>
            message.content ===
            [
              '<skill_content name="evidence">',
              "# Skill: evidence",
              "",
              expectedBody,
              "",
              `Base directory for this skill: ${skillDirectory}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              `<file>${skillFile}</file>`,
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
        ),
        `${logs}\nTool results: ${JSON.stringify(toolMessages)}\nSession messages: ${JSON.stringify(await api(`/session/${session.id}/message`))}`,
      );
    }
    // The first skill-tool invocation happens only after these edits. Config
    // loading must already have captured snippets unused by agents/commands.
    await writeFile(
      join(project, `${configDirectory}/prompts/review/nested.txt`),
      "updated",
    );
    await writeFile(skillOnlyPath, "Skill-only updated");
    await rm(deletedPath);
    await writeFile(
      join(project, `${configDirectory}/prompts/review/override.txt`),
      "Project added",
    );
    await writeFile(
      join(project, `${configDirectory}/prompts/literal.md`),
      "An escaped marker must never expand twice.",
    );
    const subsequent = (await api("/config")) as typeof config;
    assert.equal(subsequent.agent.review.prompt, config.agent.review.prompt);
    assert.equal(
      subsequent.command.check.template,
      config.command.check.template,
    );
    const originalSkill = [
      "Skill Project evidence",
      "Skill-only original",
      "Deleted original",
      "Global original",
      "{{include:literal.md}}",
    ].join("\n");
    await exerciseSkill(originalSkill);
    assert.equal(
      await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      skillText,
    );

    const slashSession = (await api("/session", {})) as { id: string };
    const beforeSlash = received.length;
    const slashToasts = await watchToasts();
    const slashMessage = await api(`/session/${slashSession.id}/command`, {
      command: "evidence",
      arguments: "",
      agent: "review",
      model: "fixture/model",
    });
    assert.match(JSON.stringify(slashMessage), /Verified/);
    assert.deepEqual(
      await slashToasts.until((toast) => toast.message.includes("evidence")),
      {
        title: "Prompt Composer",
        message:
          'Skill "evidence" ran as a slash command, which does not expand includes; its markers were sent as written. Ask the agent to load the skill instead.',
        variant: "warning",
      },
    );
    const slashMessages = received.slice(beforeSlash).flatMap(
      (body) =>
        (
          JSON.parse(body) as {
            messages: { role: string; content: unknown }[];
          }
        ).messages,
    );
    // Native title generation can issue another request. Assert the route's
    // content and absence of tool results instead of assuming a request count.
    assert.ok(slashMessages.every((message) => message.role !== "tool"));
    const slashUsers = slashMessages.filter(
      (message) => message.role === "user",
    );
    assert.ok(
      slashUsers.some((message) =>
        JSON.stringify(message.content).includes(
          "Skill {{include:review/body.md}}",
        ),
      ),
    );
    assert.ok(
      slashUsers.every(
        (message) =>
          !JSON.stringify(message.content).includes("Skill Project evidence"),
      ),
    );
    const changedAgentText = agentText.replace(
      "Use evidence.",
      "Use native changes.",
    );
    const changedSkillText = skillText.replace(
      "Skill {{include:review/body.md}}",
      "Native skill {{include:review/body.md}}",
    );
    await writeFile(agentPath, changedAgentText);
    await writeFile(join(skillDirectory, "SKILL.md"), changedSkillText);
    const reloaded = await disposeInstance(
      (current) =>
        current.agent.review.prompt ===
        "Use native changes.\n\nReview Project evidence\n\nState uncertainty.\n",
    );
    assert.equal(
      reloaded.agent.review.prompt,
      "Use native changes.\n\nReview Project evidence\n\nState uncertainty.\n",
    );
    assert.equal(
      reloaded.command.check.template,
      "Check Project evidence $ARGUMENTS {{include:literal.md}}",
    );
    await exerciseSkill(
      originalSkill.replace("Skill Project", "Native skill Project"),
    );
    assert.equal(
      await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      changedSkillText,
    );
    assert.equal(await readFile(obsoletePath, "utf8"), obsoleteText);
    if (configPlugin !== undefined) {
      const profilePath = join(
        project,
        `${configDirectory}/config-composer.jsonc`,
      );
      const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
        activeProfiles: string[];
      };
      profile.activeProfiles = [];
      await writeFile(profilePath, JSON.stringify(profile));
      const cleared = await disposeInstance(
        (current) => current.agent.helper.disable === true,
      );
      assert.equal(cleared.agent.review.prompt, reloaded.agent.review.prompt);
      assert.equal(
        cleared.command.check.template,
        reloaded.command.check.template,
      );
      assert.equal(cleared.agent.helper.disable, true);
      assert.equal(
        cleared.agent.helper.prompt,
        "Help {{include:review/body.md}}\n\nState uncertainty.\n\nHelper rule.",
      );
      await exerciseConfigEditor(configPlugin, shared, api);
    } else {
      assert.equal(config.agent.helper.disable, true);
      assert.equal(
        config.agent.helper.prompt,
        "Help {{include:review/body.md}}\n\nState uncertainty.\n\nHelper rule.",
      );
      await writeFile(
        helperPath,
        helperText.replace("disable: true", "disable: false"),
      );
      const enabled = await disposeInstance(
        (current) =>
          current.agent.helper.prompt ===
          "Help Project evidence\n\nState uncertainty.\n\nHelper rule.",
      );
      assert.equal(enabled.agent.helper.disable, false);
      assert.equal(
        enabled.agent.helper.prompt,
        "Help Project evidence\n\nState uncertainty.\n\nHelper rule.",
      );
      await writeFile(helperPath, helperText);
      const disabled = await disposeInstance(
        (current) => current.agent.helper.disable === true,
      );
      assert.equal(disabled.agent.helper.disable, true);
      assert.equal(
        disabled.agent.helper.prompt,
        "Help {{include:review/body.md}}\n\nState uncertainty.\n\nHelper rule.",
      );
    }
    await exercisePromptViewer(plugin, api, agentPath).catch(
      (error: unknown) => {
        throw new Error(`Native prompt viewer failed.\n${logs}`, {
          cause: error,
        });
      },
    );
    // Check authored files before fixture writes can hide a plugin mutation.
    assert.equal(await readFile(agentPath, "utf8"), changedAgentText);
    assert.equal(await readFile(helperPath, "utf8"), helperText);

    const commandOnlyAgentText =
      "---\ndescription: Review changes\nmode: primary\n---\nReview";
    await writeFile(agentPath, commandOnlyAgentText);
    const commandOnly = await disposeInstance(
      (current) => current.agent.review.prompt === "Review",
    );
    assert.equal(commandOnly.agent.review.prompt, "Review");
    assert.equal(
      commandOnly.command.check.template,
      "Check Project evidence $ARGUMENTS {{include:literal.md}}",
      "command-only includes work without includes in the active agent body",
    );
    if (configPlugin !== undefined) {
      await exerciseConfigEditor(configPlugin, shared, api);
    }
    assert.equal(await readFile(helperPath, "utf8"), helperText);
    assert.equal(await readFile(agentPath, "utf8"), commandOnlyAgentText);
    // Native npm TUI loading and the real terminal preview run on both operating
    // systems, separately from the rendering-replaced viewer checks above.
    await writeFile(
      join(shared, "tui.jsonc"),
      JSON.stringify({ plugin: [npmPlugin] }),
    );
    await writeFile(agentPath, agentText);
    await writeFile(personalPath, "  Personal review guidance.\n");
    for (const [name, text] of Object.entries(viewerCommands)) {
      await writeFile(join(project, `${configDirectory}/commands`, name), text);
    }
    const restartedSkillText = changedSkillText.replace(
      "{{include:review/deleted.txt}}\n",
      "",
    );
    await writeFile(join(skillDirectory, "SKILL.md"), restartedSkillText);
    // A real new host process must read the changed snapshot. Reusing the same
    // package registration and filesystem avoids a module-query cache reset.
    await stopHost();
    await startHost();
    const restarted = (await api("/config")) as typeof config;
    assert.equal(
      restarted.agent.review.prompt,
      "Use evidence.\n\nReview Project updated\n\nState uncertainty.\nPersonal review guidance.",
    );
    assert.equal(
      restarted.command.check.template,
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
    );
    await exerciseSkill(
      [
        "Native skill Project updated",
        "Skill-only updated",
        "Project added",
        "{{include:literal.md}}",
      ].join("\n"),
    );
    assert.equal(
      await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      restartedSkillText,
    );
    const terminalSession = (await api("/session", {})) as { id: string };
    const loadedAgents = (await api("/agent")) as {
      name: string;
      native?: boolean;
      prompt?: string;
    }[];
    const builtin = loadedAgents.find(
      (agent) =>
        agent.native === true &&
        !Object.hasOwn(restarted.agent, agent.name) &&
        agent.prompt !== undefined &&
        agent.prompt !== "",
    );
    assert.ok(
      builtin !== undefined,
      "Native terminal fixture needs a built-in prompt",
    );
    const beforeTerminal = received.length;
    assert.ok(url !== undefined);
    await exerciseNativeTerminal({
      binary,
      url,
      sessionID: terminalSession.id,
      builtin: builtin.name,
      project,
      env,
      signal: t.signal,
    });
    assert.equal(
      received.length,
      beforeTerminal,
      "TUI preview must not send a model prompt",
    );
    assert.equal(await readFile(agentPath, "utf8"), agentText);
    assert.equal(await readFile(helperPath, "utf8"), helperText);
    assert.equal(await readFile(buildPath, "utf8"), buildText);
    assert.equal(await readFile(obsoletePath, "utf8"), obsoleteText);

    await writeFile(personalPath, Buffer.from([0xff]));
    await stopHost();
    await startHost();
    const unreadable = (await api("/config")) as typeof config;
    assert.equal(
      unreadable.agent.review.prompt,
      "Use evidence.\n\nReview Project updated\n\nState uncertainty.\n",
      `a present optional snippet that cannot be read as UTF-8 text is left out while the rest of the prompt composes\n${logs}`,
    );
    assert.equal(
      unreadable.command.check.template,
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
      "other consumers still compose",
    );
  },
);
