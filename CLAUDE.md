# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build              # ESM + CJS dual build
npm run lint               # eslint src/ tests/
npm run lint:fix           # eslint --fix
npm run format             # prettier --write
npm run format:check       # prettier --check (CI runs this)
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run test:watch         # vitest (watch mode)
npm run test:coverage      # vitest with 80% coverage thresholds
```

Run a single test file: `npx vitest run tests/unit/factories.test.ts`

## Architecture

This is a cloud-agnostic Pulumi infrastructure library. The primary API is **synchronous factory functions** that dispatch to AWS/Azure implementations via static imports.

### Flow: User → Factory → Provider

```
createNetwork("prod", { cloud: "aws", ... })
  → factories/network.ts (resolves cloud target)
    → aws/network.ts (creates VPC, subnets, NAT)
      → returns INetwork
```

### Key directories

- **`src/factories/`** — Cloud-agnostic entry points. Each factory uses `isMultiCloud()` to branch between single and array dispatch, and statically imports provider modules.
- **`src/aws/`**, **`src/azure/`** — Provider implementations. All Pulumi SDK peer deps are required (npm 7+ auto-installs them).
- **`src/types/`** — `CloudArg` resolution (`"aws"` | `{provider, region}` | array), error classes with codes, validation, tag normalization.
- **`src/platform/`** — Helm-based components (Traefik, cert-manager, ArgoCD, etc.) deployed to any `ICluster`.

### Multi-cloud pattern

All factories accept `CloudArg` which can be a single target or an array. When an array is passed:

1. `isMultiCloud()` returns true
2. `resolveCloudTarget()` returns `ResolvedCloudTarget[]`
3. Factory maps over targets, prefixing names with provider (`prod-aws`, `prod-azure`)
4. For networks, CIDRs are auto-offset (`10.0.0.0/16`, `10.1.0.0/16`, etc.)

### Provider options

Cloud-specific config flows through `providerOptions: { aws?: IAwsProviderOptions, azure?: IAzureProviderOptions }` on factory configs. Azure always requires `resourceGroupName`.

### Interface contracts

Every resource output has: `name`, `cloud: ResolvedCloudTarget`, `nativeResource: pulumi.Resource` (escape hatch). Interfaces live in `<module>/interfaces.ts`, implementations in `aws/` and `azure/`.

## Conventions

- Import paths must use `.js` extensions (`import { ... } from "../aws/index.js"`) for Node16 module resolution.
- Use `import type` for type-only imports (enforced by eslint).
- Prefix interface names with `I` (INetwork, ICluster). Types use plain PascalCase. Constants use UPPER_SNAKE_CASE.
- Errors extend `AnyCloudError` with a machine-readable `code` field.
- `readonly` on all interface properties.
- Double quotes, semicolons, 100-char print width, es5 trailing commas (Prettier).
- No `any` — eslint `@typescript-eslint/no-explicit-any: error`.

## Testing

Tests use vitest with `vi.mock()` to intercept imports of `../../src/aws` and `../../src/azure`. Factory tests verify dispatch logic, multi-cloud naming, CIDR offsets, and error paths without needing actual cloud SDKs.

Coverage excludes: index barrels, interface-only files, aws/azure implementations (integration-tested separately), cli.ts, platform stack.

## Build

Dual ESM/CJS output via separate tsconfig files (`tsconfig.esm.json` → `dist/esm/`, `tsconfig.cjs.json` → `dist/cjs/`). Package exports field routes `import`/`require` to correct variant. Subpath exports (`@reyemtech/nimbus/aws`, `./azure`) give direct provider access.

## CI

GitHub Actions runs: lint → format:check → typecheck → test:coverage → build on Node 20 + 22. Releases via semantic-release on main (only after CI passes). `[skip release]` in commit message skips publishing.

**IMPORTANT: Always run CI checks locally before pushing:**

```bash
npm run format:check && npm run lint && npm run typecheck && npm run test:coverage
```

Fix any issues before pushing. Do not push code that hasn't passed all four checks locally.

## Branching

Feature branches follow `feature/REY-<number>-<description>`. Always branch off main, PR back to main.

## TypeScript Best Practices (MANDATORY)

Follow these strictly across the entire codebase:

### Code Quality

- **Strict mode always** — `"strict": true` in tsconfig.json, no `any` types (use `unknown` + type guards instead)
- **Explicit return types** on all public functions and methods
- **Interface over type** for object shapes that will be extended or implemented
- **Readonly by default** — use `readonly` on properties that shouldn't change after construction
- **Prefer `const` assertions** and `as const` for literal types
- **No magic numbers/strings** — extract to named constants or enums
- **Discriminated unions** for variant types (e.g., AWS vs Azure config)
- **Exhaustive switch/case** — use `never` type to catch missing cases at compile time

### Architecture & Modularity

- **No file should exceed 500 lines** — split into smaller, focused modules if approaching this limit
- **Single responsibility** — each file/class/function does one thing well
- **Barrel exports** — use `index.ts` files to re-export public API from each module directory
- **Dependency injection** — pass dependencies explicitly, don't rely on singletons or global state
- **Composition over inheritance** — prefer composing behaviors via interfaces and factory functions
- **Pure functions** where possible — deterministic, no side effects, easy to test

### Naming & Organization

- **Interfaces** prefixed with `I` (e.g., `ICluster`, `INetwork`)
- **Types** in PascalCase (e.g., `CloudTarget`, `ClusterConfig`)
- **Functions** in camelCase (e.g., `createCluster`, `validateCidr`)
- **Constants** in UPPER_SNAKE_CASE (e.g., `DEFAULT_REGIONS`, `MAX_RETRY_COUNT`)
- **Files** in kebab-case (e.g., `eks-cluster.ts`, `azure-network.ts`)
- **One class per file**, named the same as the class (e.g., `EksCluster` → `eks-cluster.ts`)
- **Group by feature**, not by type (e.g., `src/cluster/aws/eks-cluster.ts`, not `src/classes/eks-cluster.ts`)

### Error Handling

- **Custom error classes** extending `Error` for domain-specific errors (e.g., `CloudValidationError`, `CidrOverlapError`)
- **Fail fast** — validate inputs at the boundary, throw early with clear messages
- **No swallowed errors** — always handle or propagate, never empty `catch {}`
- **Result types** for operations that can fail expectedly (not exceptions for control flow)

### Testing

- **Test file mirrors source** — `src/cluster/aws/eks-cluster.ts` → `tests/unit/cluster/aws/eks-cluster.test.ts`
- **Arrange-Act-Assert** pattern in every test
- **Mock at boundaries** — mock cloud API calls, not internal logic
- **Test edge cases** — empty arrays, undefined optionals, invalid inputs, multi-cloud arrays with one element

### Documentation

- **TypeDoc on every public export** — interfaces, classes, functions, types, constants
- **@example blocks** in TypeDoc for complex APIs
- **@throws** tags documenting which errors a function can throw
- **README per feature directory** — `src/cluster/README.md`, `src/platform/README.md`, etc.
