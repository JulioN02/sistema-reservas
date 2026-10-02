# Skill Registry

**Delegator use only.** Any agent that launches sub-agents reads this registry to resolve compact rules, then injects them directly into sub-agent prompts. Sub-agents do NOT read this registry or individual SKILL.md files.

See `_shared/skill-resolver.md` for the full resolution protocol.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| When writing TypeScript code — types, interfaces, generics | typescript | ~/.config/opencode/skills/typescript/SKILL.md |
| When writing React components — no useMemo/useCallback needed | react-19 | ~/.config/opencode/skills/react-19/SKILL.md |
| When working with Next.js — routing, Server Actions, data fetching | nextjs-15 | ~/.config/opencode/skills/nextjs-15/SKILL.md |
| Cuando se inicia un nuevo proyecto, se planifica una iteración, o se pide desarrollo por flujos completos | vertical-slices | ~/.config/opencode/skills/vertical-slices/SKILL.md |
| Cuando se toquen temas de seguridad, APIs, integraciones, testing, code review, o auditoría explícita | code-auditor | ~/.config/opencode/skills/code-auditor/SKILL.md |
| Cuando se trabajen propuestas, specs, diseño, tareas, o se pida revisión crítica | design-critic | ~/.config/opencode/skills/design-critic/SKILL.md |
| When writing E2E tests — Page Objects, selectors, MCP workflow | playwright | ~/.config/opencode/skills/playwright/SKILL.md |
| Automate browser interactions, test web pages and work with Playwright tests | playwright-cli | ~/.claude/skills/playwright-cli/SKILL.md |
| When user says "judgment day", "review adversarial", "dual review", "doble review", "juzgar", "que lo juzguen" | judgment-day | ~/.config/opencode/skills/judgment-day/SKILL.md |
| When creating a pull request, opening a PR, or preparing changes for review | branch-pr | ~/.config/opencode/skills/branch-pr/SKILL.md |
| When creating a GitHub issue, reporting a bug, or requesting a feature | issue-creation | ~/.config/opencode/skills/issue-creation/SKILL.md |
| When writing Go tests, using teatest, or adding test coverage | go-testing | ~/.config/opencode/skills/go-testing/SKILL.md |
| Cuando se crea, actualiza o unifica un dashboard de evidencia para GitHub Pages | dashboard-pages | ~/.config/opencode/skills/dashboard-pages/SKILL.md |
| When user asks to create a new skill, add agent instructions, or document patterns for AI | skill-creator | ~/.config/opencode/skills/skill-creator/SKILL.md |
| When saving discoveries, decisions, or user asks to "remember", "recall", "save this" | engram-memory | ~/.agents/skills/engram-memory/SKILL.md |

## Compact Rules

Pre-digested rules per skill. Delegators copy matching blocks into sub-agent prompts as `## Project Standards (auto-resolved)`.

### typescript
- Const types pattern REQUIRED: `const X = {...} as const` then `type T = (typeof X)[keyof typeof X]`; NEVER direct union literals
- Flat interfaces: max one level of nesting; nested objects → dedicated named interface; use `extends` for inheritance
- NEVER `any` — use `unknown` + type guards (`value is T`), or generics
- Prefer utility types: Pick, Omit, Partial, Record, ReturnType, Parameters
- Import types with `import type { X }` — never inline in value imports

### react-19
- No useMemo/useCallback — React Compiler handles memoization automatically
- Named imports only: `import { useState } from "react"`; never `import React from "react"`
- Server Components by default; add "use client" only for hooks, event handlers, or browser APIs
- `use()` hook reads promises and context (enables conditional context — not possible with useContext)
- Actions: use `useActionState` for form mutations with pending state; `"use server"` for server actions
- ref is a regular prop — no forwardRef needed

### nextjs-15
- App Router conventions: layout.tsx (root required), page.tsx, loading.tsx, error.tsx, not-found.tsx; route groups `(auth)` have no URL impact; `_components` is a private non-routed folder
- Server Components default and async; fetch data in parallel with Promise.all; stream with Suspense
- Server Actions: mark `"use server"`, call `revalidatePath` + `redirect` after mutations
- Route handlers: `app/api/<route>/route.ts` with NextRequest/NextResponse
- middleware.ts at root; export matcher config

### vertical-slices
- Build by complete vertical flows (DB → API → UI → tests) per iteration; NEVER by isolated layers
- 4 phases per iteration: CONTRATO (OpenAPI spec first, validated with 0 errors) → ESQUELETO (structure with mocks) → LÓGICA (business logic, ≥70% coverage on critical services) → PULIDO (security/perf; no redesign)
- Module structure: routes / controller (thin, 10–15 lines max) / service (pure, framework-independent) / repository (parametrized queries) / dto / tests
- API-first: version from the start (`/api/v1/...`); contract defined before code; never break existing contracts — breaking change → new version
- Multi-tenant: client_id in ALL queries, injected from auth middleware; authorization verified in service layer
- DB: 3NF baseline; one migration per iteration; never modify executed migrations; explicit enums for states, never free strings
- Validation layers: frontend = UX only (can be bypassed), backend DTO = source of truth, DB constraints = final safety net
- Regression protocol: failing test → fix → test passes → commit test + fix together, never separately
- No optimization without profiling; no abstraction without need (YAGNI)

### code-auditor
- Complementary, never blocking: CRITICAL → fix now (vulnerability, data leak), WARNING → fix soon, SUGGESTION → optional, INFO → context
- OWASP Top 10 baseline: always parametrized queries (Prisma `$queryRaw` tagged), JWT `verify` never `decode` only, select only needed fields in responses, tenant isolation via clientId from auth middleware, CORS specific origins (never `*`), helmet + rate limiting
- Activate on: auth/authorization, user input handling, DB queries/migrations, external APIs, secrets, files, testing, code review

### design-critic
- Never assume — if not explicit, ask; always question "why X and not Y"
- Finding types: ❓PREGUNTA (blocks if critical), ⚠️SEÑALAMIENTO (unjustified decision), 🔍SUPUESTO, 📐COHERENCIA (contradiction), 💡SUGERENCIA
- Review checklist: edge cases, error handling, validation, auth, performance, logging/monitoring, testing, docs, rollback/migration
- SDD phase focus: propose → intent/scope; spec → edge cases + measurable criteria; design → trade-offs; tasks → missing validation tasks
- Report format: questions table with priority + "bloquea" column

### playwright
- If Playwright MCP available: navigate + snapshot + interact BEFORE writing any test; document real selectors from snapshots; never assume how UI works
- File structure: tests/{page}/{page}-page.ts (Page Object), {page}.spec.ts (ALL tests for the page in one file), {page}.md (docs)
- Selector priority: getByRole > getByLabel > getByText > getByTestId (last resort); NEVER CSS classes or IDs
- Scope: "a test" → one test() in existing spec; "suite/all tests" → full suite
- All pages extend BasePage; goto() waits for "networkidle"

### playwright-cli
- CLI browser automation: `playwright-cli open`, `goto <url>`, `type`, `click <ref>`, `fill <ref> "text" --submit`, `press Enter`, `screenshot`, `close`
- Use snapshot refs (e.g., `e15`) for interaction, not CSS selectors

### judgment-day
- Launch TWO blind judge sub-agents in parallel via delegate; same target, independent; orchestrator never reviews itself
- Verdict synthesis: Confirmed (both) → fix immediately; Suspect A/B → triage; Contradiction → manual decision
- WARNING classification: real (causes bug/data loss/security hole in realistic scenario → fix) vs theoretical (contrived scenario → report as INFO, no re-judge)
- Fix agent → re-launch both judges; escalate after 2 iterations if not converged
- Resolve compact rules from skill registry first; inject into BOTH judges + fix agent identically

### branch-pr
- Every PR MUST link an approved issue (`status:approved`) — blank PRs are blocked by CI
- Branch naming regex: `^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`
- PR body MUST include `Closes #N` and exactly one `type:*` label
- Use .github/PULL_REQUEST_TEMPLATE.md; conventional commits; shellcheck on modified scripts

### issue-creation
- Blank issues disabled — MUST use template (bug_report.yml or feature_request); issue gets `status:needs-review` automatically
- A maintainer MUST add `status:approved` before any PR can be opened
- Search duplicates first; fill pre-flight checkboxes; questions go to Discussions, not issues

### go-testing
- Table-driven tests are the standard Go pattern; golden file testing for complex output
- teatest for Bubbletea TUI testing (Gentleman.Dots context)
- Not relevant to sistema-reservas (JS/TS stack) — keep for Go projects

### dashboard-pages
- One single dashboard version — NEVER coexist a single-file dashboard.html AND a dashboard/ folder with the same page
- docs/index.html root MUST reach the interactive version via relative `meta refresh` (e.g., `./dashboard/`)
- Zero external dependencies: no CDN, no build step, relative paths only → works on file:// and GitHub Pages
- Interactivity without server: simulation engine in inline script or local app.js; evidence data embedded or in docs/output-*.txt
- Dedicated repo JulioN02/<project> with docs/ as Pages root; commit EVERYTHING referenced (untracked files are not deployed)

### skill-creator
- Create a skill when: pattern repeats and AI needs guidance, project conventions differ from generic best practices, complex workflow needs steps
- Do NOT create when: docs already exist, pattern is trivial, one-off task
- Structure: skills/{name}/SKILL.md (required) + optional assets/ + references/
- Frontmatter: name, description (include "Trigger:"), license, metadata

### engram-memory
- Call mem_save PROACTIVELY after any decision, bugfix, discovery, or convention — do not wait to be asked
- Content format: **What** / **Why** / **Where** / **Learned**
- Use topic_key for evolving topics (upsert); different topics must not overwrite each other
- To recall: mem_search → mem_get_observation(id) for full untruncated content
- Call mem_session_summary before ending a session

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| AGENTS.md (user-level) | ~/.config/opencode/AGENTS.md | Neutral professional Spanish for all user-facing output; English for code/comments/commits; Engram protocol mandatory; gentle-ai ecosystem |
| gentle-ai.mdc (user-level) | ~/.cursor/rules/gentle-ai.mdc | Orchestrator rules: SDD workflow, artifact store policy (engram default), delegation rules, topic key format |
| README.md | README.md | Project definition: problem, v1 scope, stack, done-criteria |
| plan-ataque-temporada-2.md | ../../docs/plan-ataque-temporada-2.md | Section 4 = microproducto spec; Section 8 = operational rules (neutral Spanish, SDD per product, TDD, engram memory, no commit without request) |

Read the convention files listed above for project-specific patterns and rules. All referenced paths have been extracted — no need to read index files to discover more.