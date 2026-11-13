# Publishing

The [Release workflow](https://github.com/lunchbox-labs/prompt-composer-plugin/blob/main/.github/workflows/release.yml) runs only when started by hand on `main`, and publishes only when its **publish** input is checked. It releases the workspace's one version in one run: it publishes `@lunchbox-labs/opencode-prompt-composer` and `@lunchbox-labs/kilo-prompt-composer` to npm in that order, creates the `v<version>` tag on the release commit once, and publishes a GitHub release for that tag with the two package tarballs attached and notes generated from the merged pull requests. Branch pushes, pull requests and tag pushes do not publish packages. The shared core in `packages/core` is private: it is bundled into both packages at build time and is never packed or published.

## Publisher setup

The workflow expects these settings, configured through the respective services. This page describes the required setup, not confirmation of its current state.

- **npm trusted publishers:** one on each of the two packages, each with organization `lunchbox-labs`, repository `prompt-composer-plugin`, workflow filename `release.yml` and environment `release`. Allow direct `npm publish`, which is the command this workflow uses. npm offers the setting only on a package that exists, so [bootstrap](#bootstrap-a-new-package-name) a package name that has never been published first. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
- **`release` environment:** allows deployments from `main` only. It holds no secrets or variables.
- **Actions policy:** only maintainers may start Release, and Wiki may run only on pushes to `main`. Both can write to the repository.
- **Tag rulesets:** a ruleset blocks updating and deleting `v*` tags. No ruleset blocks creating them, because Release creates the tag itself.

The publish job has `id-token: write` for OIDC and `contents: read`. It installs a trusted-publishing-capable npm version and enables provenance. The workflow does not use a long-lived npm token. Only the GitHub release job has `contents: write`, and it runs no repository code. Both jobs run in the `release` environment.

## Bootstrap a new package name

Verify stops a run when either package name is not on npm, before anything is published. `@lunchbox-labs/opencode-prompt-composer` is already on npm, so only `@lunchbox-labs/kilo-prompt-composer` needs this. To add a package name, a maintainer with publish rights in the `lunchbox-labs` npm organization publishes a placeholder of it once, under its own dist-tag. The placeholder is a bare manifest with no code and no dependencies, not the built package: npm points `latest` at a package's first version until a stable release moves it, and an install of `latest` must get a harmless placeholder, not a build that was never released. In an empty directory outside the repository:

```sh
cat > package.json <<'JSON'
{
  "name": "@lunchbox-labs/kilo-prompt-composer",
  "version": "0.0.0-bootstrap.0",
  "description": "Placeholder that reserves the name; install a released version.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/lunchbox-labs/prompt-composer-plugin.git"
  }
}
JSON
npm publish --tag bootstrap --access public
npm deprecate @lunchbox-labs/kilo-prompt-composer@0.0.0-bootstrap.0 "Placeholder; install a released version."
npm dist-tag ls @lunchbox-labs/kilo-prompt-composer
```

For any later new package, use its own name. The bootstrap version is never used for a release. `npm dist-tag ls` shows where `bootstrap` and `latest` point; `latest` moves to the first stable version that Release publishes. Then add the package's trusted publisher as above. If a placeholder of `@lunchbox-labs/prompt-composer-core` was ever published, leave it deprecated; no release publishes that name.

Start Release with **publish** unchecked to confirm that Verify passes. That run stops before npm, so it does not exercise the trusted publisher or OIDC. If a trusted publisher is missing or wrong, the first real run publishes the packages before that one and fails at it. Fix the publisher and re-run only the failed jobs within the artifact's three days: Publish npm skips the packages npm already holds with the same tarballs and publishes the rest.

## Prepare and run a release

1. Set the same version in `packages/opencode/package.json` and `packages/kilo/package.json`, and run `npm install` so their workspace entries in `package-lock.json` match. The private core's version is not released and need not change. Use a non-placeholder semantic version that has no tag and isn't on npm yet for either package: a stable version such as `1.2.3` for a release, or a pre-release version such as `1.2.3-beta.1` for a pre-release.
2. Complete the required checks and review, and integrate the release commit into `main` through the repository's normal process.
3. Open **Actions**, choose **Release**, and select **Run workflow** with `main` as the branch and **publish** checked. The run releases the commit at the head of `main` when it starts, so start it once the release commit is the latest commit there. Run it once per version.

The run has two inputs:

- **publish:** off by default. Unchecked, the run builds, checks and packs the release and keeps the tarballs only as the run's `release` artifact, then stops before npm, the tag and the GitHub release. It still stops at Verify when the version is already tagged or on npm. Check it to publish the official release.
- **prerelease:** publishes under npm's `next` tag instead of `latest`, and marks the GitHub release as a pre-release. A pre-release run needs a pre-release version, and a normal run a stable one, so `latest` never moves to a pre-release.

The run's summary names the version as soon as the **Release version** job finishes, and links the release once the **GitHub release** job has published it. Don't push the tag or create the release by hand: Release refuses a version that is already tagged, and tags can't be moved or deleted.

## What the run does

**Release version** stops a run started on any other branch, reads the version from the two package manifests and stops when they differ. **Verify** then requires the checked-out commit to match the run's commit, and stops before building when either package name is not on npm yet, when `v<version>` is already tagged, or when either package already has the version on npm. [validate-release.mjs](https://github.com/lunchbox-labs/prompt-composer-plugin/blob/main/scripts/validate-release.mjs) also validates each package's identity, repository, registry, access and lockfile metadata, and that neither package names the private core in any dependency field. Verify runs `npm ci` and `npm run test:package`, packs the two packages and uploads the tarballs with SHA-256 checksums.

**Check** runs the [Check workflow](https://github.com/lunchbox-labs/prompt-composer-plugin/blob/main/.github/workflows/check.yml) on the release commit as part of the run, with every job it runs on a push to `main`. Its runs inside Release are grouped apart from Check's own runs, so a push to `main` during a release doesn't cancel them.

**Publish npm** downloads the verified tarballs, checks their checksums and publishes them with scripts disabled, OpenCode first, then Kilo. It does not rebuild the packages. **GitHub release** then creates the `v<version>` tag on the release commit and publishes a GitHub release for it with the same tarballs attached.

If a job fails, inspect it before retrying, and re-run only the failed jobs so the verified packages are reused. Re-running Publish npm is safe after a partial publication: it skips each package npm already holds at this version with the same tarball, publishes the rest in order, and stops at a package npm holds with a different tarball. Re-running GitHub release accepts an existing tag only on the release commit, publishes a draft left for the tag with the tarballs attached, and leaves an already published release as it is. A new run, or a full re-run, stops at verification once the version is tagged or on npm, so finish a partly failed release by re-running its failed jobs within the artifact's three days. After that, bump the version, merge it to `main` and run Release again. Keep release-specific investigation and validation evidence in the tracking issue.
