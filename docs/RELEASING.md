# Releasing

Releases publish the same source revision through three channels:

- `agentic-data-kernel` on npm;
- `ghcr.io/jason-doyle/agentic-data-kernel` on GitHub Container Registry;
- a GitHub Release containing the npm tarball and SHA-256 checksums.

The release workflow builds multi-architecture container images for
`linux/amd64` and `linux/arm64`. npm packages published from the workflow carry
registry provenance, and container images receive a GitHub artifact
attestation.

Release workflows are serialized. A tag is rejected when a newer tag already
exists in the same stable or prerelease channel, which prevents an older
release from moving `latest` or `next` backwards.

## Version tags

`package.json` is the source of truth for the version. A release tag must be
exactly `v<package-version>`, and its commit must be contained in `main`.

Prerelease versions receive:

- the npm `next` distribution tag;
- the container `next` tag;
- a GitHub prerelease.

Stable versions receive the npm and container `latest` tags.

Consumers should pin exact versions in production even when a moving tag is
available.

## First npm publication

npm requires the package to exist before its trusted publisher can be
configured. Bootstrap the first release with a short-lived granular npm token:

1. Create a granular token that can publish public packages and satisfies the
   account's two-factor authentication policy.
2. Store it as the `NPM_TOKEN` GitHub Actions repository secret.
3. Push the first version tag and wait for the Release workflow to finish.
4. In the npm settings for `agentic-data-kernel`, configure a GitHub Actions
   trusted publisher with:
   - owner: `Jason-Doyle`;
   - repository: `agentic-data-kernel`;
   - workflow filename: `release.yml`;
   - environment: none.
5. Delete the `NPM_TOKEN` repository secret.
6. Require two-factor authentication and disallow token-based publishing in the
   npm package settings.

Later releases use GitHub OIDC and do not require an npm token. The workflow
uses npm 12 because trusted publishing requires a recent npm CLI.

## First container publication

GitHub Container Registry may create the first image as private. After the
first workflow completes:

1. Open the `agentic-data-kernel` container package settings under the
   `Jason-Doyle` account.
2. Confirm it is linked to this repository.
3. Change its visibility to public.
4. Verify an unauthenticated pull of the exact version tag.

Package visibility is a one-time registry setting and is not changed by the
workflow.

## Preparing a release

1. Update the version without creating a tag:

   ```powershell
   npm version <version> --no-git-tag-version
   ```

2. Update:
   - `CHANGELOG.md`;
   - the release version in `README.md`;
   - `AGENTIC_DATA_IMAGE` in `.env.example`.
3. Run:

   ```powershell
   npm run release:check
   docker compose --env-file .env.example config --quiet
   docker build --tag agentic-data-kernel:release-check .
   ```

4. Merge the release pull request to `main`.
5. Confirm CI and CodeQL pass on the merge commit.
6. Create and push an annotated tag:

   ```powershell
   git switch main
   git pull --ff-only origin main
   git tag -a v<version> -m "Release <version>"
   git push origin v<version>
   ```

The tag starts `.github/workflows/release.yml`. The GitHub Release is created
only after npm and container publication succeed.

## Verification

For a prerelease:

```powershell
npm view agentic-data-kernel@next version
docker pull ghcr.io/jason-doyle/agentic-data-kernel:<version>
gh release view v<version> --repo Jason-Doyle/agentic-data-kernel
```

Confirm the npm provenance statement, container attestation, release checksums,
and exact source revision before announcing the release.
