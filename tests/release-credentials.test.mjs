import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const source = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const workflow = parse(source);
const action =
  "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510";
const token = "${{ steps.app-token.outputs.token }}";
const inputs = {
  "client-id": "${{ vars.LUNCHBOX_LABS_APP_CLIENT_ID }}",
  "private-key": "${{ secrets.LUNCHBOX_LABS_APP_PRIVATE_KEY }}",
  owner: "${{ github.repository_owner }}",
  repositories: "${{ github.event.repository.name }}",
  "permission-contents": "write",
  "skip-token-revoke": false,
};

test("App release tokens use pinned action, exact credentials, one repository and job-end revocation", () => {
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.env, undefined);
  for (const [jobName, stage] of [
    ["prepare", "prepare"],
    ["finish", "finish"],
  ]) {
    const job = workflow.jobs[jobName];
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.equal(job.environment, "release");
    const index = job.steps.findIndex((step) => step.uses === action);
    assert.ok(index >= 0, `${jobName} must mint its own App token`);
    const mint = job.steps[index];
    assert.equal(mint.id, "app-token");
    assert.deepEqual(mint.with, inputs);
    const api = job.steps[index + 1];
    assert.equal(api.run, `node scripts/release-lifecycle.mjs ${stage}`);
    assert.equal(api.env.GH_TOKEN, token);
    assert.equal(api.uses, undefined);
  }
});

test("App credentials and tokens never escape their minting and release API steps", () => {
  let mints = 0;
  let consumers = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.doesNotMatch(
      JSON.stringify(job.env ?? {}),
      /LUNCHBOX_LABS_APP_|app-token|GH_TOKEN/,
    );
    assert.doesNotMatch(
      JSON.stringify(job.outputs ?? {}),
      /token|private-key|secrets\.|vars\./,
    );
    for (const [index, step] of job.steps.entries()) {
      const text = JSON.stringify(step);
      if (step.uses === action) {
        mints++;
        assert.ok(["prepare", "finish"].includes(jobName));
      } else {
        assert.doesNotMatch(text, /LUNCHBOX_LABS_APP_|secrets\./);
        if (text.includes(token)) {
          consumers++;
          assert.ok(["prepare", "finish"].includes(jobName));
          assert.equal(job.steps[index - 1].uses, action);
          assert.deepEqual(
            Object.entries(step.env).filter(([, value]) => value === token),
            [["GH_TOKEN", token]],
          );
        }
      }
    }
  }
  assert.equal(mints, 2);
  assert.equal(consumers, 2);
  assert.equal(source.match(/LUNCHBOX_LABS_APP_PRIVATE_KEY/g)?.length, 2);
  assert.equal(source.match(/LUNCHBOX_LABS_APP_CLIENT_ID/g)?.length, 2);
});

test("npm keeps ordinary read token and OIDC while builds and artifacts have no App credentials", () => {
  assert.equal(workflow.jobs.verify.environment, undefined);
  const publish = workflow.jobs.publish;
  assert.deepEqual(publish.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(publish.environment, "npm");
  const npm = publish.steps.find((step) =>
    step.run?.includes("node scripts/release-lifecycle.mjs npm"),
  );
  assert.equal(npm.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(npm.env.NPM_CONFIG_PROVENANCE, "true");
  for (const job of [workflow.jobs.verify, publish]) {
    assert.doesNotMatch(
      JSON.stringify(job),
      /LUNCHBOX_LABS_APP_|app-token|create-github-app-token/,
    );
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps.filter((entry) =>
      entry.uses?.startsWith("actions/checkout@"),
    )) {
      assert.equal(step.with["persist-credentials"], false);
      assert.equal(step.with.token, undefined);
    }
  }
});
