# Projects

Recorded before either tool was run on any project. All clones are shallow, at the commit below,
in a scratch directory outside this repository. Dependencies were installed with the project's
own package manager and lockfile, with lifecycle scripts disabled (`--ignore-scripts`).

| Project                                                  | Kind                    | Commit                                     | License | Tests                           | Counted |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------ | ------- | ------------------------------- | ------- |
| [vercel/ms](https://github.com/vercel/ms)                | utility (calibration)   | `4ff48cec099f0514c3e9bbca18706c9c21122bfb` | MIT     | jest                            | no      |
| [unjs/scule](https://github.com/unjs/scule)              | pure logic / utility    | `5bc68048caad7c0e7de35842c83a510e8e1a7c4f` | MIT     | vitest                          | yes     |
| [unjs/ufo](https://github.com/unjs/ufo)                  | parsing                 | `f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6` | MIT     | vitest                          | yes     |
| [pmndrs/zustand](https://github.com/pmndrs/zustand)      | state                   | `382d29c485e67018c06e75ec7235130d0968522c` | MIT     | vitest                          | yes     |
| [mantinedev/mantine](https://github.com/mantinedev/mantine) `@mantine/hooks` | React hooks | `82fb128c43f9927c1370a2732cd5aa9e6663ca11` | MIT | jest + Testing Library | yes |
| [alibaba/hooks](https://github.com/alibaba/hooks) (ahooks) | React hooks           | `a0c33c21caefda40753fe4b3cbb3b1efbabd1a79` | MIT     | vitest + Testing Library        | yes     |
| [honojs/hono](https://github.com/honojs/hono) middleware | server / middleware     | `eb754bd5ef22c63f1634a4c374a86be086f85710` | MIT     | vitest                          | yes     |

Public docs used for the blind guarantees:

- ms, scule, ufo: the README at the commit (ufo's README is generated from its JSDoc)
- zustand: `docs/reference/apis/create-store.md`, `docs/reference/apis/shallow.md`,
  `docs/reference/middlewares/persist.md` at the commit
- mantine: `apps/mantine.dev/src/pages/hooks/<hook>.mdx` at the commit
- ahooks: `packages/hooks/src/<hook>/index.en-US.md` at the commit
- hono: [honojs/website](https://github.com/honojs/website) `docs/middleware/builtin/*.md` at
  `6d4ba9115255b16a3a7388670787731ec49461ea`

## Scope

The scope is both `surface.include` (specgate) and `mutate` (Stryker).

| Project | Files                                                                                                                             | Operations with guarantees                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ms      | `src/index.ts`                                                                                                                    | `ms`, `parse`, `parseStrict`, `format`                                                                                          |
| scule   | `src/index.ts`                                                                                                                    | `splitByCase`, `upperFirst`, `lowerFirst`, `pascalCase`, `camelCase`, `kebabCase`, `snakeCase`, `flatCase`, `trainCase`, `titleCase` (`isUppercase` is exported but undocumented, so it has none) |
| ufo     | `src/parse.ts`, `src/query.ts`                                                                                                    | `parseURL`, `parsePath`, `parseAuth`, `parseHost`, `stringifyParsedURL`, `parseFilename`, `parseQuery`, `encodeQueryItem`, `stringifyQuery` |
| zustand | `src/vanilla.ts`, `src/vanilla/shallow.ts`, `src/middleware/persist.ts`                                                          | `createStore`, `shallow`, `createJSONStorage`, `persist`                                                                        |
| mantine | `packages/@mantine/hooks/src/use-{counter,disclosure,toggle,pagination,queue,os}/use-*.ts`                                        | `useCounter`, `useDisclosure`, `useToggle`, `usePagination`, `useQueue`, `useOs`                                                |
| ahooks  | `packages/hooks/src/{useCounter,useToggle,useBoolean}/index.ts`                                                                   | `useCounter`, `useToggle`, `useBoolean`                                                                                         |
| hono    | `src/middleware/cors/index.ts`, `src/middleware/secure-headers/secure-headers.ts`, `src/middleware/body-limit/index.ts`, `src/middleware/request-id/request-id.ts` | `cors`, `secureHeaders`, `NONCE`, `bodyLimit`, `requestId`                                                    |

## Why each was picked

- **ms** — the calibration case from the README; small, value-heavy, previously measured.
- **scule** — string-case utilities: pure functions, a documented default list of splitters (a
  module-level collection is likely), README examples that name exact outputs.
- **ufo** — URL and query parsing: a parsing library with exact examples per function. The
  parse and query modules were chosen because they are the README's "Parsing" and "Query"
  groups.
- **zustand** — the most used small state library. `createStore` is closure-heavy with few
  literal values; `persist` has documented defaults (version, merge, `skipHydration`). Chosen
  over `neverthrow` (result type), whose last commit was in February 2026, because zustand's
  reference docs state defaults that a contract can name.
- **mantine `@mantine/hooks`** — React hooks tested with Testing Library (`renderHook`), named
  exports, very active. Six hooks with documented behaviour, from trivial (`useDisclosure`) to
  value-heavy (`usePagination`, `useOs`).
- **ahooks** — React hooks tested with Testing Library and vitest, active. Every hook is a
  default export (`export default useCounter`, `export default function useBoolean`). From
  reading specgate's surface extraction while choosing projects, a default export is expected
  to give no unit in 0.5.0. It is kept as a project, and run, to test that expectation as an
  applicability result. mantine was added so that the React kind also has measurable data.
- **hono middleware** — server code: four middleware with documented header names and defaults
  (CORS methods, secure-header values, request-id header and length).

## Screened out before any run

| Candidate                 | Reason                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `juliencrn/usehooks-ts`   | last commit on the default branch 2025-02-06, outside the 12-month maintenance window    |
| `react-hookz/web`         | tests use `@ver0/react-hooks-testing`, not Testing Library                               |
| `kwhitley/itty-router`    | tests run with `bun test`, not vitest or jest                                            |
| a CLI tool (optional kind) | not included; the five required kinds were filled first                                  |

## Runner notes

- hono declares pnpm 12, whose lockfile pnpm 10 cannot read; pnpm 12.6.0 from npm was used.
- mantine's jest config covers the whole monorepo; runs are restricted to
  `packages/@mantine/hooks` with jest's path argument (Stryker: `jest.config` `roots`).
