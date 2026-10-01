# Releasing pi-nimble-compact

Stable GitHub releases publish the matching package version to npm. Draft releases, prereleases, ordinary commits, and tag pushes do not publish. CI runs the offline checks on pull requests and main; publishing runs them again.

## One-time setup

The npm package name is **pi-nimble-compact**, without a scope. The npm account `nicolamustone` must own it or have publishing access. The registry currently returns 404 for this name; this is not a guarantee that npm will accept or reserve it.

Trusted publishing needs an existing npm package. Register the first version manually, then enable CI publishing:

1. Merge this setup into main. Prepare the first release's version and dated changelog entry using the procedure below, and merge that release-preparation PR.
2. In a clean checkout of that main commit, run:

   ```sh
   npm ci --ignore-scripts
   npm run check
   node scripts/verify-release.mjs v0.1.0
   npm publish --dry-run --ignore-scripts --registry=https://registry.npmjs.org
   npm login --registry=https://registry.npmjs.org
   # This makes version 0.1.0 public and cannot be overwritten:
   npm publish --access public --ignore-scripts --registry=https://registry.npmjs.org
   ```

   Use the prepared version instead of `0.1.0` if it changes. Complete npm's login/2FA prompts. If npm rejects the name or access, resolve that before creating a GitHub release.

3. In [GitHub environments](https://github.com/SirDarcanos/pi-nimble-compact/settings/environments), create an environment named **npm**. Add required reviewers if your GitHub plan supports them. No npm token secret is needed.
4. From [your npm packages](https://www.npmjs.com/settings/nicolamustone/packages), open **pi-nimble-compact → Settings → Trusted Publisher**, select GitHub Actions, and enter:
   - Organization or user: `SirDarcanos`
   - Repository: `pi-nimble-compact`
   - Workflow filename: `publish.yml` (not the full path)
   - Environment name: `npm`
   - Allowed actions: enable direct `npm publish`.
5. After a successful CI publish, consider restricting traditional tokens through npm's Publishing access settings. Keep interactive 2FA available for recovery.

For the manually published first version, disable **Publish to npm** in GitHub Actions before creating its GitHub tag/release, then re-enable it afterward. That version is already on npm; do not rerun its publish job or try to republish it. Subsequent versions use CI normally.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) for dashboard details and requirements. The workflow uses a GitHub-hosted runner, Node 24, npm 11 (OIDC requires npm ≥11.5.1), and public-package provenance. Account setup is manual; this repository does not store credentials.

## Prepare each release

1. Start a release-preparation branch from updated main. Choose a stable Semantic Versioning version: patch for fixes, minor for compatible features, major for breaking changes. Prereleases are not supported by this workflow.
2. Update both manifests without creating a tag:

   ```sh
   npm version 0.1.1 --no-git-tag-version
   ```

   For the first release, keep the existing `0.1.0` if appropriate; no version command is needed.
3. Move pending entries from `CHANGELOG.md` into a dated section, for example `## [0.1.1] - YYYY-MM-DD` using the actual release date. Leave an Unreleased section for future work and update its comparison link and the version link.
4. Verify:

   ```sh
   npm ci --ignore-scripts
   npm run check
   node scripts/verify-release.mjs v0.1.1
   npm pack --dry-run --ignore-scripts
   git diff --check
   ```

5. Commit the manifests and changelog, open a PR to main, and merge only after CI passes.

## Publish through GitHub

From clean, updated main, tag the exact merged release commit and create a stable release:

```sh
git switch main
git pull --ff-only
node scripts/verify-release.mjs v0.1.1
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
gh release create v0.1.1 --verify-tag --title "v0.1.1" --notes-file /path/to/release-notes.md
```

Write the notes file from that version's changelog entries first. Alternatively, publish a release for the existing tag through GitHub's Releases UI. Creating a release is the publish trigger; approve the npm environment deployment if configured.

The job verifies that the tagged commit belongs to main, the stable tag matches `package.json` and `package-lock.json`, and the changelog contains that version's dated heading. It then runs tests (including packed-package loading), previews the package, and publishes publicly with OIDC and provenance.

After it succeeds, verify:

```sh
npm view pi-nimble-compact@0.1.1 version --registry=https://registry.npmjs.org
pi install npm:pi-nimble-compact
```

## Failures and retries

- **Authentication failure:** check the npm trusted-publisher fields, direct-publish permission, and exact environment name. Do not add a long-lived token as a workaround.
- **Checks failed before publish:** fix the cause. If release content must change, prepare a new commit and version; do not move a public release tag.
- **Publish failed before npm accepted the version:** rerun the failed Actions job after resolving infrastructure or account configuration.
- **Version already exists:** verify the registry version. A workflow rerun cannot overwrite a published version; use a new version for changes.
- **Prerelease:** the publish job is intentionally skipped; do not mark a prerelease stable unless it follows the stable version process above.
