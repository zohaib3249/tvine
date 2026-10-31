# Releasing

One npm package, `tvine` (`packages/tvine`). A pushed `vX.Y.Z` tag publishes it
(`.github/workflows/release.yml`).

## Every release

```bash
# 1. bump "version" in packages/tvine/package.json (e.g. 0.1.0 -> 0.1.1)
git commit -am "release v0.1.1"
git push origin main
# 2. tag the commit on main
git tag v0.1.1 && git push --tags
```

The workflow then:

- refuses a tag whose commit is not on `main`
- builds (`pnpm install --frozen-lockfile && pnpm -r build`)
- fails if the tag is not `v` + the `tvine` version
- runs `npm publish --provenance --access public` (skipped with a notice if that version is already on npm, so a re-run is safe)
- creates the GitHub release with generated notes and the `npm pack` tarball attached

## One-time setup

- On npmjs.com create an **Automation** access token for the account that owns `tvine`.
- In the GitHub repo: Settings → Secrets and variables → Actions → new repository secret `NPM_TOKEN` with that token.
