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
import { resolveNativeVersion, verifyNativeVersion } from "./native-host.ts";
import { exerciseNativeTerminal } from "./native-terminal.ts";
import { prepareRipgrep } from "./native-ripgrep.ts";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run native tests through npm");

test(
  "npm-registered native hooks preserve authored files, reload, discover overrides and compose on-demand skills",
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
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: join(root, "db.sqlite"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
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
    const testSupport = JSON.parse(
      await readFile(new URL("./opencode.json", import.meta.url), "utf8"),
    ) as { range: string; floor: string };
    const range = testSupport.range;
    verifyNativeVersion(testSupport.floor, range);
    const version = await resolveNativeVersion({
      npm,
      range,
      cache: join(root, "metadata-cache"),
      env: installEnv,
      signal: t.signal,
      requested:
        process.env.OPENCODE_TEST_VERSION === "floor"
          ? testSupport.floor
          : process.env.OPENCODE_TEST_VERSION,
    });
    t.diagnostic(
      `Native OpenCode ${version}; tested OpenCode range=${range}; lane=${process.env.OPENCODE_TEST_VERSION ?? "latest-compatible"}`,
    );
    const name =
      process.platform === "win32"
        ? "opencode-windows-x64"
        : "opencode-linux-x64";
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
      process.platform === "win32" ? "opencode.exe" : "opencode",
    );
    const actual = (
      await execute(binary, ["--version"], {
        env,
        timeout: 30_000,
        signal: t.signal,
      })
    ).stdout.trim();
    verifyNativeVersion(version, range, actual);
    await prepareRipgrep(root, env, t.signal);
    const packed = await execute(
      process.execPath,
      [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: resolve("."), env: installEnv, timeout: 60_000, signal: t.signal },
    );
    const [{ filename }] = JSON.parse(packed.stdout) as { filename: string }[];
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
        join(root, filename),
      ],
      { env: installEnv, timeout: 120_000, signal: t.signal },
    );
    const plugin = join(
      install,
      "node_modules/@lunchbox-labs/opencode-prompt-composer",
    );
    const project = join(root, "project");
    const shared = join(root, "config/opencode");
    for (const path of [
      join(project, ".opencode/prompts/review"),
      join(project, ".opencode/agents"),
      join(project, ".opencode/commands"),
      join(project, ".opencode/skills/evidence"),
      join(shared, "prompts/review"),
    ]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(join(shared, "prompts/review/body.md"), "Shared");
    await writeFile(
      join(project, ".opencode/prompts/review/body.md"),
      "Project {{include:review/nested.txt}}",
    );
    await writeFile(
      join(project, ".opencode/prompts/review/nested.txt"),
      "evidence",
    );
    const agentPath = join(project, ".opencode/agents/review.md");
    const agentText =
      "---\ndescription: Review changes\nmode: primary\n---\nUse evidence.\n\nReview {{include:review/body.md}}\n\nState uncertainty.";
    await writeFile(agentPath, agentText);
    const helperPath = join(project, ".opencode/agents/helper.md");
    const helperText =
      "---\ndescription: Optional helper\nmode: subagent\ndisable: true\n---\nHelp {{include:review/body.md}}\n\nState uncertainty.\n\nHelper rule.";
    await writeFile(helperPath, helperText);
    await writeFile(
      join(project, ".opencode/commands/check.md"),
      "---\ndescription: Native command\nagent: review\nsubtask: true\n---\nCheck {{include:review/body.md}} $ARGUMENTS \\{{include:literal.md}}",
    );
    const skillDirectory = join(project, ".opencode/skills/evidence");
    const skillBody =
      "Skill {{include:review/body.md}}\n\\{{include:literal.md}}";
    const skillText = `---\nname: evidence\ndescription: Evidence checklist\n---\n${skillBody}`;
    await writeFile(join(skillDirectory, "SKILL.md"), skillText);
    // Colons are not valid in Windows filenames; unit tests cover Windows-shaped
    // wrapper metadata too. POSIX native loading proves filenames remain literal.
    const skillFile = join(
      skillDirectory,
      process.platform === "win32" ? "reference.txt" : "{{include:wrapper.md}}",
    );
    await writeFile(skillFile, "Sampled filename, not prompt content.");
    const obsoletePath = join(project, ".opencode/prompt-composer.jsonc");
    const obsoleteText = "{ malformed obsolete policy: ignored";
    await writeFile(obsoletePath, obsoleteText);
    const tarball = await readFile(join(root, filename));
    const manifest = JSON.parse(
      await readFile(join(plugin, "package.json"), "utf8"),
    ) as { name: string; version: string };
    let registry = "";
    let tarballRequests = 0;
    const received: string[] = [];
    const modelServer = createServer((request, response) => {
      if (decodeURIComponent(request.url ?? "") === `/${manifest.name}`) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            name: manifest.name,
            "dist-tags": { latest: manifest.version },
            versions: {
              [manifest.version]: {
                ...manifest,
                dist: { tarball: `${registry}/plugin.tgz` },
              },
            },
          }),
        );
        return;
      }
      if (request.url === "/plugin.tgz") {
        tarballRequests++;
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(tarball);
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
      join(shared, "opencode.jsonc"),
      JSON.stringify({
        plugin: plugins,
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
        join(project, ".opencode/config-composer.jsonc"),
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
    for (const directory of [shared, join(project, ".opencode")]) {
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
          `@opencode-ai/plugin@${version}`,
        ],
        { cwd: directory, env: installEnv, timeout: 120_000, signal: t.signal },
      );
    }
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
    let logs = "";
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
    };
    let url: string | undefined;
    for (let n = 0; n < 600; n++) {
      url = /https?:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      if (url !== undefined) {
        break;
      }
      if (child.exitCode !== null) {
        throw new Error(`OpenCode exited: ${logs}`);
      }
      await setTimeout(100);
    }
    assert.ok(url !== undefined, `OpenCode did not start: ${logs}`);
    async function api(path: string, body?: unknown): Promise<unknown> {
      const response = await fetch(`${url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": project,
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
    async function reload(
      ready: (current: typeof config) => boolean,
    ): Promise<typeof config> {
      await api("/instance/dispose", {});
      // Disposal acknowledges before teardown finishes. Wait for the fixture's
      // changed prompt/availability to prove the new composition is loaded.
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
      "Use evidence.\n\nReview Project evidence\n\nState uncertainty.",
      logs,
    );
    assert.equal(
      config.command.check.template,
      "Check Project evidence $ARGUMENTS {{include:literal.md}}",
    );
    assert.equal(config.command.check.subtask, true);
    // OpenCode derives skill commands after config hooks, directly from cached
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
    const session = (await api("/session", {})) as { id: string };
    const message = await api(`/session/${session.id}/message`, {
      agent: "review",
      model: { providerID: "fixture", modelID: "model" },
      parts: [{ type: "text", text: "Load evidence now." }],
    });
    assert.match(JSON.stringify(message), /Verified/);
    assert.ok(
      received.some((body) => body.includes("Skill Project evidence")),
      `${logs}\nFixture model requests: ${JSON.stringify(received)}\nSession messages: ${JSON.stringify(await api(`/session/${session.id}/message`))}`,
    );
    const toolMessages = received.flatMap((body) =>
      (
        JSON.parse(body) as { messages: { role: string; content: string }[] }
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
            "Skill Project evidence\n{{include:literal.md}}",
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
      JSON.stringify(toolMessages),
    );
    assert.equal(
      await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      skillText,
    );

    const slashSession = (await api("/session", {})) as { id: string };
    const beforeSlash = received.length;
    const slashMessage = await api(`/session/${slashSession.id}/command`, {
      command: "evidence",
      arguments: "",
      agent: "review",
      model: "fixture/model",
    });
    assert.match(JSON.stringify(slashMessage), /Verified/);
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
    await writeFile(
      join(project, ".opencode/prompts/review/nested.txt"),
      "updated",
    );
    const reloaded = await reload(
      (current) =>
        current.agent.review.prompt ===
        "Use evidence.\n\nReview Project updated\n\nState uncertainty.",
    );
    assert.equal(
      reloaded.agent.review.prompt,
      "Use evidence.\n\nReview Project updated\n\nState uncertainty.",
    );
    assert.equal(
      reloaded.command.check.template,
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
    );
    assert.equal(await readFile(obsoletePath, "utf8"), obsoleteText);
    if (configPlugin !== undefined) {
      const profilePath = join(project, ".opencode/config-composer.jsonc");
      const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
        activeProfiles: string[];
      };
      profile.activeProfiles = [];
      await writeFile(profilePath, JSON.stringify(profile));
      const cleared = await reload(
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
      const enabled = await reload(
        (current) =>
          current.agent.helper.prompt ===
          "Help Project updated\n\nState uncertainty.\n\nHelper rule.",
      );
      assert.equal(enabled.agent.helper.disable, false);
      assert.equal(
        enabled.agent.helper.prompt,
        "Help Project updated\n\nState uncertainty.\n\nHelper rule.",
      );
      await writeFile(helperPath, helperText);
      const disabled = await reload(
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
    assert.equal(await readFile(agentPath, "utf8"), agentText);
    assert.equal(await readFile(helperPath, "utf8"), helperText);

    // Command-only includes work without includes in the active agent body.
    const commandOnlyAgentText =
      "---\ndescription: Review changes\nmode: primary\n---\nReview";
    await writeFile(agentPath, commandOnlyAgentText);
    const commandOnly = await reload(
      (current) => current.agent.review.prompt === "Review",
    );
    assert.equal(commandOnly.agent.review.prompt, "Review");
    assert.equal(
      commandOnly.command.check.template,
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
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
    await reload(
      (current) =>
        current.agent.review.prompt ===
        "Use evidence.\n\nReview Project updated\n\nState uncertainty.",
    );
    const terminalSession = (await api("/session", {})) as { id: string };
    let beforeTerminal = received.length;
    let expectedAgent = "";
    let expectedCommand = "";
    let expectedSkill = "";
    let expectedNested = "";
    let expectedGlobal = "";
    let terminalModelRequests = 0;
    await exerciseNativeTerminal({
      binary,
      url,
      sessionID: terminalSession.id,
      project,
      env,
      signal: t.signal,
      async editPrompts(stage) {
        assert.equal(
          received.length,
          beforeTerminal,
          "Viewing prompts must not send a model request",
        );
        if (stage === "broken") {
          await writeFile(
            agentPath,
            expectedAgent.replace("review/body.md", "missing.md"),
          );
          return;
        }
        expectedAgent = agentText.replace(
          "Review {{include:",
          `${stage} agent {{include:`,
        );
        expectedCommand = `---\ndescription: Native command\nagent: review\nsubtask: true\n---\n${stage} command {{include:review/body.md}} $ARGUMENTS \\{{include:literal.md}}`;
        expectedSkill = `---\nname: evidence\ndescription: Evidence checklist\n---\n${stage} skill {{include:review/body.md}}\n\\{{include:literal.md}}`;
        expectedNested = stage;
        await writeFile(agentPath, expectedAgent);
        await writeFile(
          join(project, ".opencode/commands/check.md"),
          expectedCommand,
        );
        await writeFile(join(skillDirectory, "SKILL.md"), expectedSkill);
        await writeFile(
          join(project, ".opencode/prompts/review/nested.txt"),
          expectedNested,
        );
        // Global JSON is process-cached by the supported host. Instance reload
        // must not pretend to invalidate it or rewrite it as a workaround.
        const globalPath = join(shared, "opencode.jsonc");
        const globalConfig = JSON.parse(await readFile(globalPath, "utf8")) as {
          default_agent: string;
        };
        globalConfig.default_agent = "build";
        expectedGlobal = JSON.stringify(globalConfig);
        await writeFile(globalPath, expectedGlobal);
      },
      async verifyReload(stage) {
        assert.equal(
          received.length,
          beforeTerminal,
          "Reloading prompts must not send a model request",
        );
        const loaded = (await api("/config")) as typeof config & {
          default_agent: string;
        };
        if (stage === "broken") {
          try {
            assert.ok(
              loaded.agent.review.prompt.includes("{{include:missing.md}}"),
              "OpenCode swallows the failed composition hook and returns native uncomposed text",
            );
            assert.ok(
              loaded.command.check.template.includes(
                "{{include:review/body.md}}",
              ),
              "Failed composition must publish no partial agent/command results",
            );
            assert.match(logs, /missing\.md/);
          } finally {
            await writeFile(agentPath, expectedAgent);
          }
          return;
        }
        assert.equal(
          loaded.agent.review.prompt,
          `Use evidence.\n\n${stage} agent Project ${stage}\n\nState uncertainty.`,
        );
        assert.equal(
          loaded.command.check.template,
          `${stage} command Project ${stage} $ARGUMENTS {{include:literal.md}}`,
        );
        assert.equal(
          loaded.default_agent,
          "review",
          "Current-instance disposal does not invalidate process-cached global JSON",
        );
        const commands = (await api("/command")) as {
          name: string;
          template: string;
        }[];
        assert.ok(
          commands
            .find((command) => command.name === "evidence")
            ?.template.startsWith(
              `${stage} skill {{include:review/body.md}}`,
            ) === true,
          "Native skill cache must reread SKILL.md",
        );
        const session = (await api("/session", {})) as { id: string };
        const start = received.length;
        const message = await api(`/session/${session.id}/message`, {
          agent: "review",
          model: { providerID: "fixture", modelID: "model" },
          parts: [{ type: "text", text: "Load evidence after reload." }],
        });
        assert.match(JSON.stringify(message), /Verified/);
        const requests = received.slice(start);
        assert.ok(
          requests.some((body) =>
            body.includes(`${stage} agent Project ${stage}`),
          ),
          "The next model request must receive the refreshed agent",
        );
        assert.ok(
          requests.some((body) =>
            body.includes(`${stage} skill Project ${stage}`),
          ),
          "The real skill tool must receive the refreshed body and includes",
        );
        const tools = requests.flatMap((body) =>
          (
            JSON.parse(body) as {
              messages: { role: string; content: unknown }[];
            }
          ).messages.filter((message) => message.role === "tool"),
        );
        assert.ok(
          tools.some((message) =>
            JSON.stringify(message.content).includes("{{include:literal.md}}"),
          ),
          "Repeated reload must preserve the escaped marker without expanding it again",
        );
        terminalModelRequests += requests.length;
        beforeTerminal = received.length;
        assert.equal(await readFile(agentPath, "utf8"), expectedAgent);
        assert.equal(
          await readFile(join(project, ".opencode/commands/check.md"), "utf8"),
          expectedCommand,
        );
        assert.equal(
          await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
          expectedSkill,
        );
        assert.equal(
          await readFile(
            join(project, ".opencode/prompts/review/nested.txt"),
            "utf8",
          ),
          expectedNested,
        );
        assert.equal(
          await readFile(join(shared, "opencode.jsonc"), "utf8"),
          expectedGlobal,
        );
        assert.equal(await readFile(helperPath, "utf8"), helperText);
        assert.equal(await readFile(obsoletePath, "utf8"), obsoleteText);
      },
    });
    assert.equal(
      received.length,
      beforeTerminal,
      "TUI preview must not send a model prompt",
    );
    assert.ok(
      terminalModelRequests >= 4,
      "Both reload paths must be followed by an actual agent and skill request",
    );
    // Restore a healthy loaded instance after characterizing a swallowed hook error.
    await reload((current) =>
      current.agent.review.prompt.includes("menu agent Project menu"),
    );
    assert.equal(await readFile(agentPath, "utf8"), expectedAgent);
  },
);
