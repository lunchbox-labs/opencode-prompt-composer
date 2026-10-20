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
import { fileURLToPath } from "node:url";
import {
  exerciseConfigEditor,
  exercisePromptEditor,
} from "./native-editors.ts";
import { readState } from "../src/runtime-state.ts";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run native tests through npm");
const version = process.env.OPENCODE_TEST_VERSION ?? "1.19.0";
assert.match(
  version,
  /^1\.19\.\d+$/,
  "Native baseline must be an exact supported patch",
);

test(
  "npm-registered native hooks preserve authored files, reload, discover overrides and compose on-demand skills",
  { timeout: 360_000 },
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
    let binary = process.env.OPENCODE_BIN;
    if (binary === undefined) {
      const name =
        process.platform === "win32"
          ? "opencode-windows-x64"
          : "opencode-linux-x64";
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
      binary = join(
        root,
        "host/node_modules",
        name,
        "bin",
        process.platform === "win32" ? "opencode.exe" : "opencode",
      );
    }
    assert.equal(
      (
        await execute(binary, ["--version"], {
          env,
          timeout: 30_000,
          signal: t.signal,
        })
      ).stdout.trim(),
      version,
    );
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
      "---\ndescription: Review changes\nmode: primary\n---\nReview {{include:review/body.md}}";
    await writeFile(agentPath, agentText);
    const helperPath = join(project, ".opencode/agents/helper.md");
    const helperText =
      "---\ndescription: Optional helper\nmode: subagent\ndisable: true\n---\nHelp {{include:review/body.md}}";
    await writeFile(helperPath, helperText);
    await writeFile(
      join(project, ".opencode/commands/check.md"),
      "---\ndescription: Native command\nagent: review\nsubtask: true\n---\nCheck {{include:review/body.md}} $ARGUMENTS \\{{include:literal.md}}",
    );
    await writeFile(
      join(project, ".opencode/skills/evidence/SKILL.md"),
      "---\nname: evidence\ndescription: Evidence checklist\n---\nSkill {{include:review/body.md}}",
    );
    const settingsPath = join(project, ".opencode/prompt-composer.jsonc");
    const settingsText = JSON.stringify({
      defaults: { append: ["State uncertainty."] },
      agents: {
        review: { prepend: ["Use evidence."] },
        helper: { append: ["Helper rule."] },
      },
    });
    await writeFile(settingsPath, settingsText);
    const tarball = await readFile(join(root, filename));
    let tarballRequests = 0;
    const received: string[] = [];
    const modelServer = createServer((request, response) => {
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
        const base = {
          id: "fixture",
          model: "fixture",
          created: 1,
          object: "chat.completion.chunk",
        };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = toolReturned
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
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: toolReturned ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
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
    // A remote tarball is an npm spec, not a file entry: the real native
    // installer, package exports and engines.opencode gate all run here.
    const npmPlugin = `http://127.0.0.1:${address.port}/plugin.tgz`;
    const plugins =
      configPlugin === undefined
        ? [[npmPlugin, {}]]
        : [configPlugin, [npmPlugin, {}]];
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
    async function reload(): Promise<typeof config> {
      const previous = readState(await api("/config"), project);
      await api("/instance/dispose", {});
      // The host acknowledges dispose before teardown completes. Fixture-driven
      // reloads must observe a new attested hook pass before using the instance.
      for (let attempt = 0; attempt < 300; attempt++) {
        const current = (await api("/config")) as typeof config;
        try {
          if (readState(current, project).id !== previous.id) {
            return current;
          }
        } catch {
          // Old or partially reset config is not evidence of a completed reload.
        }
        await setTimeout(50);
      }
      throw new Error(`No fresh prompt runtime after disposal.\n${logs}`);
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
    assert.equal(await readFile(settingsPath, "utf8"), settingsText);
    const baseline = readState(config, project);
    assert.match(
      baseline.native.agent?.review?.prompt ?? "",
      /include:review\/body.md/,
    );
    if (configPlugin !== undefined) {
      assert.equal(config.agent.review.model, "fixture/model", logs);
      assert.equal(config.agent.helper.disable, false);
      assert.equal(
        config.agent.helper.prompt,
        "Help Project evidence\n\nState uncertainty.\n\nHelper rule.",
      );
      await exerciseConfigEditor(configPlugin, shared, api);
    }
    await exercisePromptEditor(plugin, api, settingsPath).catch(
      (error: unknown) => {
        throw new Error(`Native prompt editor failed.\n${logs}`, {
          cause: error,
        });
      },
    );
    await writeFile(settingsPath, settingsText);
    await reload();
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
    await writeFile(
      join(project, ".opencode/prompts/review/nested.txt"),
      "updated",
    );
    const reloaded = await reload();
    assert.equal(
      reloaded.agent.review.prompt,
      "Use evidence.\n\nReview Project updated\n\nState uncertainty.",
    );
    assert.equal(
      reloaded.command.check.template,
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
    );
    assert.equal(await readFile(settingsPath, "utf8"), settingsText);
    if (configPlugin !== undefined) {
      const profilePath = join(project, ".opencode/config-composer.jsonc");
      const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
        activeProfiles: string[];
      };
      profile.activeProfiles = [];
      await writeFile(profilePath, JSON.stringify(profile));
      const cleared = await reload();
      assert.equal(cleared.agent.review.prompt, reloaded.agent.review.prompt);
      assert.equal(
        cleared.command.check.template,
        reloaded.command.check.template,
      );
      assert.equal(cleared.agent.helper.disable, true);
      assert.equal(
        cleared.agent.helper.prompt,
        "Help {{include:review/body.md}}",
      );
      await exerciseConfigEditor(configPlugin, shared, api);
      await exercisePromptEditor(plugin, api, settingsPath).catch(
        (error: unknown) => {
          throw new Error(`Native prompt editor failed.\n${logs}`, {
            cause: error,
          });
        },
      );
    } else {
      assert.equal(config.agent.helper.disable, true);
      assert.equal(
        config.agent.helper.prompt,
        "Help {{include:review/body.md}}",
      );
      await writeFile(
        helperPath,
        helperText.replace("disable: true", "disable: false"),
      );
      const enabled = await reload();
      assert.equal(enabled.agent.helper.disable, false);
      assert.equal(
        enabled.agent.helper.prompt,
        "Help Project updated\n\nState uncertainty.\n\nHelper rule.",
      );
      await writeFile(helperPath, helperText);
      const disabled = await reload();
      assert.equal(disabled.agent.helper.disable, true);
      assert.equal(
        disabled.agent.helper.prompt,
        "Help {{include:review/body.md}}",
      );
    }
    // Check authored files before fixture writes can hide a plugin mutation.
    assert.equal(await readFile(agentPath, "utf8"), agentText);
    assert.equal(await readFile(helperPath, "utf8"), helperText);

    // Command-only includes work independently of agent fragment settings.
    const commandOnlyAgentText =
      "---\ndescription: Review changes\nmode: primary\n---\nReview";
    await writeFile(agentPath, commandOnlyAgentText);
    await writeFile(settingsPath, "{}");
    const commandOnly = await reload();
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
    assert.equal(await readFile(settingsPath, "utf8"), "{}");
    // Native terminal registration is distinct from the rendering-replaced editor
    // checks above. Windows still runs the npm server/editor/reload suite.
    if (process.platform === "linux") {
      await writeFile(
        join(shared, "tui.jsonc"),
        JSON.stringify({ plugin: [npmPlugin] }),
      );
      await writeFile(agentPath, agentText);
      await writeFile(settingsPath, settingsText);
      await stopHost();
      const terminal = await execute(
        "python3",
        [
          fileURLToPath(new URL("./native-tui.py", import.meta.url)),
          binary,
          project,
        ],
        {
          env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
          timeout: 130_000,
          signal: t.signal,
          maxBuffer: 1_000_000,
        },
      );
      assert.match(
        terminal.stdout,
        /native npm TUI rendered Prompt Composer and composed preview/,
      );
    }
  },
);
