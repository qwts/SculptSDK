# SculptSDK

Typed semantic browser control for agentic systems.

## Development

Requires Node `22.11.x`–`22.x` and pnpm `10.x` (see `engines` / `packageManager`
in `package.json`; CI pins Node `22.22.2` and pnpm `10.33.0`).

```sh
pnpm install --frozen-lockfile
pnpm build       # compiles packages/core, adapter-testing, adapter-playwright, in that order
pnpm typecheck   # runs `pnpm build` first, then `tsc --noEmit` in every package
pnpm test        # vitest run
```

### Why `typecheck` runs `build` first

`adapter-testing` and `adapter-playwright` depend on `@sculptsdk/core` through
its published `exports` map, which points at `dist/*.d.ts`. Those declaration
files only exist after `packages/core` has been built, so a clean checkout's
`tsc --noEmit` fails for the adapters until `dist` is populated. Rather than
add a parallel path-mapping that could type-check against different code than
the adapters resolve at runtime, `pnpm typecheck` encodes the real build order
explicitly: `pnpm build && pnpm -r run typecheck`. `packages/core`'s own
`typecheck` script additionally regenerates `src/generated/kernel-source.ts`
(the bundled in-page kernel) before invoking `tsc`, since `src/sculpt.ts`
imports it directly.

CI (`.github/workflows/ci.yml`) runs `build`, `typecheck` and `test` as
separate steps, in that order, from a clean checkout, with no secrets and no
network access beyond the package registry.
