# Publishing

The `publish.yml` workflow verifies a stable tag already on `main`, checks metadata, runs checks plus packed-install and native tests, then publishes the checksummed tarball in a separate job. Only the publishing job receives OIDC permission, through the `npm` environment. This public repository enables npm provenance.

After your first manual npm release, configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for `@lunchbox-labs/opencode-prompt-composer`:

- GitHub owner: `lunchbox-labs`
- Repository: `opencode-prompt-composer`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allow direct `npm publish`.

Create the GitHub `npm` environment and choose its release protection rules. No npm token secret is needed. Configure the environment and publisher grant separately; the workflow does not create them.

For later versions, update the package and lockfile version together, merge to `main`, tag that commit `vX.Y.Z`, and publish a stable GitHub release. The workflow rejects prereleases, mismatched versions, wrong package/repository metadata, and commits outside `main`. npm versions are immutable: use a new version after the manually published first release.

Manual dispatch is available on `main` with a stable tag pointing at that same commit, keeping provenance tied to the correct source. For an older release, rerun its original release workflow instead. Neither ordinary pushes nor pull requests publish packages.

After npm publication succeeds, a separate attachment job downloads the exact version's `dist.tarball` from the npm registry, verifies the registry integrity digest and the package name/version inside the archive, then attaches those published bytes to the matching GitHub release. It does not rebuild or repack the release asset. Only this attachment job receives GitHub `contents: write`; npm publishing retains its separate OIDC permissions.

The `.tgz` is the npm package archive, not a standalone bundle: it does not include its runtime dependencies. Install it through npm so dependencies are resolved normally.

If the attachment job fails after publication, rerun only the failed job through GitHub Actions. npm versions are immutable; do not rerun a successful publish job to repair an asset upload. An existing same-name release asset is downloaded and compared byte for byte with the verified registry tarball. Identical bytes succeed without uploading again; different bytes fail for manual investigation. The workflow never overwrites or deletes an existing asset. A matching stable GitHub release must already exist, including for manual dispatch; the attachment job does not create releases.
