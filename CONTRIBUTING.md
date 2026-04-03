# Contributing to compras

## Project structure

```
src/
  version.ts                  <- single source of truth for version
  index.ts                    <- CLI entry point (commander)
  mcp.ts                      <- MCP server entry point
  output.ts                   <- JSON/table output helpers
  session.ts                  <- cookie persistence (~/.compras/sessions/)
  types.ts                    <- all TypeScript interfaces
  platforms/
    platform.ts               <- GroceryPlatform interface
    continente/
      index.ts                <- ContinenteClient (browser automation)
    pingo-doce/
      index.ts                <- PingoDoceClient (browser automation)
scripts/
  bump.ts                     <- version bump script
```

## Setup

```bash
bun install
bunx playwright install webkit
```

## Running

```bash
bun run dev                   # CLI (direct, no build)
bun run mcp                   # MCP server (stdio)
bun run typecheck             # type check (no emit)
```

## Adding a new command

1. Add the method to `src/platforms/platform.ts` (interface)
2. Implement it in both `src/platforms/continente/index.ts` and `src/platforms/pingo-doce/index.ts`
3. Add any new types to `src/types.ts`
4. Add the CLI command to the `registerPlatformCommands()` function in `src/index.ts`
5. Add the MCP tool to the `platformTools()` function in `src/mcp.ts`
6. Update `SKILL.md` and `README.md`

Both CLI and MCP must expose the same functionality. The MCP server is the primary
interface for agents, the CLI is for humans.

## Adding a new platform

1. Create `src/platforms/<name>/index.ts` with a class implementing `GroceryPlatform`
2. Add a `registerPlatformCommands()` call in `src/index.ts`
3. Add a `PLATFORMS` entry in `src/mcp.ts`
4. Session support is automatic (keyed by platform name)

## Releasing a new version

```bash
bun run bump patch            # 0.1.0 -> 0.1.1
bun run bump minor            # 0.1.0 -> 0.2.0
bun run bump major            # 0.1.0 -> 1.0.0
```

This updates `src/version.ts`, `package.json`, and `SKILL.md`. Then:

```bash
git add -A
git commit -m "chore: bump to vX.Y.Z"
git push
```

## Architecture notes

- **No public API.** Both stores lack public APIs. Everything is browser automation via Playwright WebKit.
- **Each client method launches a fresh browser.** Stateless by design. Session cookies are loaded from disk.
- **WebKit, not Chromium.** WAFs on some stores block Playwright Chromium. WebKit with Safari UA works.
- **DOM scraping with API interception.** Search intercepts XHR responses first, falls back to DOM scraping.
- **Shared platform interface.** Both platforms implement `GroceryPlatform`, so the CLI and MCP code are platform-agnostic.
- **Pingo Doce + Cloudflare.** Pingo Doce uses Cloudflare bot management. Headed mode may be required for login.
