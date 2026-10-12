# Publishing

The `publish.yml` workflow uses two jobs: verify a stable tag already on `main`, check metadata, run checks plus packed-install and native tests, then publish the checksummed tarball. Only the publishing job receives OIDC permission, through the `npm` environment. This public repository enables npm provenance.

After your first manual npm release, configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for `@lunchbox-labs/opencode-prompt-composer`:

- GitHub owner: `lunchbox-labs`
- Repository: `opencode-prompt-composer`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allow direct `npm publish`.

Create the GitHub `npm` environment and choose its release protection rules. No npm token secret is needed. This PR does not create the environment, publisher grant, initial package or release.

For later versions, update the package and lockfile version together, merge to `main`, tag that commit `vX.Y.Z`, and publish a stable GitHub release. The workflow rejects prereleases, mismatched versions, wrong package/repository metadata, and commits outside `main`. npm versions are immutable: use a new version after the manually published first release.

Manual dispatch is available on `main` with a stable tag pointing at that same commit, keeping provenance tied to the correct source. For an older release, rerun its original release workflow instead. Neither ordinary pushes nor pull requests publish packages.
