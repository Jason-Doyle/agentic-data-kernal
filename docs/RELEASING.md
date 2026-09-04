# Releasing

Releases publish the same source revision through three channels:

- `agentic-data-kernel` on npm;
- `ghcr.io/jason-doyle/agentic-data-kernel` on GitHub Container Registry;
- a GitHub Release containing the npm tarball and SHA-256 checksums.

The release workflow builds multi-architecture container images for
`linux/amd64` and `linux/arm64`. npm packages published from the workflow carry
registry provenance. Container images include an SBOM and maximal provenance
and receive a GitHub artifact attestation. The GitHub release contains the npm
tarball, an SPDX npm SBOM, and SHA-256 checksums.

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
They also receive container tags for the full version, major/minor version, and
major version.

Consumers should pin exact versions in production even when a moving tag is
available.

## npm trusted publishing

The repository uses npm trusted publishing through GitHub OIDC. The release
workflow must not receive `NODE_AUTH_TOKEN` or a long-lived npm token.

Verify the npm package settings before a stable release:

1. Configure a GitHub Actions trusted publisher with:
   - owner: `Jason-Doyle`;
   - repository: `agentic-data-kernel`;
   - workflow filename: `release.yml`;
   - environment: none.
2. Confirm no `NPM_TOKEN` repository secret is present.
3. Require two-factor authentication and disallow token-based publishing in the
   npm package settings.

The workflow uses npm 12 because trusted publishing requires a recent npm CLI.

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
   - `src/version.ts`;
   - Helm `appVersion` and deployment example image tags.
3. Run:

   ```powershell
   npm run release:check
   npm run deployment:check
   npm run benchmark:sre:verify
   .\scripts\test-backup-restore.ps1
   docker compose --env-file .env.example config --quiet
   docker build --tag agentic-data-kernel:release-check .
   docker run --rm agentic-data-kernel:release-check `
     node dist/production/cli.js --help
   ```

4. Merge the release pull request to `main`.
5. Confirm CI and CodeQL pass on the merge commit.
6. Confirm the repository has no open Dependabot alerts.
7. Create and push an annotated tag:

   ```powershell
   git switch main
   git pull --ff-only origin main
   git tag -a v<version> -m "Release <version>"
   git push origin v<version>
   ```

The tag starts `.github/workflows/release.yml`. The GitHub Release is created
only after all tag-SHA gates, npm publication, and container publication
succeed. Do not create a beta or release-candidate tag for the 1.0 graduation.

## Verification

For a stable release:

```powershell
npm view agentic-data-kernel@latest version
npm view agentic-data-kernel@<version> dist.attestations
docker pull ghcr.io/jason-doyle/agentic-data-kernel:<version>
docker pull ghcr.io/jason-doyle/agentic-data-kernel:<major>.<minor>
docker pull ghcr.io/jason-doyle/agentic-data-kernel:<major>
docker pull ghcr.io/jason-doyle/agentic-data-kernel:latest
gh release view v<version> --repo Jason-Doyle/agentic-data-kernel
```

Confirm:

- npm `latest` resolves to the exact version and its provenance references the
  release workflow and tag commit;
- all four container tags resolve to the same multi-architecture digest;
- the image supports `linux/amd64` and `linux/arm64`;
- the container SBOM and GitHub attestation are present;
- the release tarball and SPDX SBOM match `SHA256SUMS`;
- the GitHub release targets the exact signed or annotated tag.

After `1.0.0` is verified, deprecate every npm version below 1.0.0:

```powershell
npm deprecate "agentic-data-kernel@<1.0.0" `
  "Unsupported prerelease. Upgrade to agentic-data-kernel@^1.0.0."
```

Confirm the deprecation notice is visible on an older published version.
