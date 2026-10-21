# Publishing

Run the **Publish @lunchbox-labs/opencode-prompt-composer** workflow manually on `main`. It derives the stable version from `package.json` and checks the lockfile and repository metadata. There is no tag input and no separate draft-publication step.

The workflow automates the lifecycle:

1. Validate the intended main commit and create or reuse its exact `vX.Y.Z` tag and matching draft release. Existing tags are never moved. A user-created draft targeting `main` can be reused when it resolves to the intended commit. New drafts use the title and body returned by GitHub’s automatic release-notes generator for that tag and commit. Existing draft titles and bodies are preserved, including when another actor creates the draft concurrently.
2. Run checks plus packed-install and native tests, then pack the verified build twice and require identical archives. Store the checksummed archive as a workflow artifact.
3. Publish that archive to npm with OIDC, or skip publication only when the existing version's identity, optional `gitHead`, registry integrity, internal manifest and archive bytes agree with the verified artifact and exact tag commit. A conflicting existing asset blocks npm publication.
4. Wait through bounded npm propagation delays, verify the exact published registry archive against the artifact, attach it to the draft, and publish the draft only after the asset is verified. GitHub release immutability stays enabled.

Preparation failures report a controlled lifecycle phase and typed HTTP status without response bodies or credentials. A `tag-create` failure with HTTP 403 or 422 can indicate tag-creation rulesets or token permissions; a repository or organization administrator must investigate that policy. The workflow does not change rulesets or credentials.

The npm job receives OIDC through the `npm` environment and read-only GitHub access. Only preparation and finalization receive GitHub `contents: write`. Ordinary pushes, pull requests and GitHub release publication do not publish npm packages.

Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for this public package:

- GitHub owner: `lunchbox-labs`
- Repository: `opencode-prompt-composer`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allow direct `npm publish`.

Create the GitHub `npm` environment and choose its release protection rules. No npm token secret is needed. Configure the environment and publisher grant separately; the workflow does not create them. npm provenance is enabled.

For a new version, update the package and lockfile versions together, merge to `main`, and run Publish once. The workflow creates the tag and draft, publishes npm, attaches the archive and publishes the GitHub release. It rejects prereleases, provisional or mismatched versions, source outside `main`, conflicting tags, mismatched drafts, existing npm versions with different bytes and conflicting assets.

If a job fails, rerun the failed jobs in the same workflow run. The verified artifact and intended commit remain fixed. A full rerun at the same commit checks reproducibility and reuses exact existing state; an npm publish that succeeded before a lost response is verified instead of repeated. A failed attachment leaves the release as a draft; a failed final publication reuses the identical attached asset. An already completed immutable release succeeds only after exact registry and asset verification, without writes. If npm already has the version but its matching GitHub tag or release is missing, preparation stops without creating replacement metadata; investigate that ambiguous state first. Do not start a new main-commit release with an already used version: existing tags are never moved, and mismatches require investigation or a new version.

The attached `.tgz` contains the actual published npm bytes, not a rebuild or standalone dependency bundle. Runtime dependencies are not bundled; install through npm so they are resolved normally. Existing same-name assets are downloaded and compared byte for byte. Different bytes fail without deleting or overwriting the asset.

Published immutable releases cannot have missing assets added retroactively. The existing `v0.0.4` release cannot be repaired by rerunning attachment or republishing npm; use the [published npm package](https://www.npmjs.com/package/@lunchbox-labs/opencode-prompt-composer/v/0.0.4) as the download/install fallback. Future releases attach the archive while the release is still a draft, before automatic final publication.
