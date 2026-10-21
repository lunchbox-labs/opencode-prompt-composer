# Publishing

Publish a stable GitHub release for a version tag already on `main`. The **Publish** workflow verifies the tagged source, checks package and lockfile metadata, runs code, packed-install and native tests, and stores a checksummed npm tarball as a workflow artifact. A separate job publishes that verified tarball to npm using OIDC through the `npm` environment with provenance enabled.

The workflow uses read-only GitHub access. It does not create or move tags, create or edit GitHub releases, or attach assets. You manage tags and release titles, notes and publication in GitHub. The build archive remains available from the workflow run's artifacts.

Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for `@lunchbox-labs/opencode-prompt-composer`:

- GitHub owner: `lunchbox-labs`
- Repository: `opencode-prompt-composer`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allow direct `npm publish`.

Create the GitHub `npm` environment and choose its release protection rules. No npm token secret is needed. Configure the environment and publisher grant separately; the workflow does not create them.

For a new version, update the package and lockfile versions together, merge to `main`, tag that commit `vX.Y.Z`, and publish a stable GitHub release. The workflow rejects prereleases, mismatched versions, wrong package/repository metadata, and commits outside `main`. npm versions are immutable: publishing an existing version fails rather than overwriting it.

Only publishing a stable GitHub release triggers this workflow. For a failed older release, rerun its original workflow run. Ordinary pushes and pull requests do not publish packages. Do not rerun a successful npm publication; use a new version for a different package.

A tag points to its original commit and workflow. Existing partial tags created before this rollback still select the older workflow. Before releasing the retained package version, handle those partial tags/releases manually and create the intended tag at the rollback merge commit, or choose a new unused package version. This workflow does not clean up existing tags or releases.
