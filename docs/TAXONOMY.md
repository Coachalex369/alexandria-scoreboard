# Workflow taxonomy (`packages/taxonomy/taxonomy.json`, `alexandria.taxonomy/1`)

## Hierarchy (eight levels)

Project → Session → Main task → Subtask → Agent → Work category → Code structure → Operation.

The first five are *scopes* carried by ids on every event (`session.project`, `session.id`, `task.id`,
subtask = turn or declared phase, `actor.agentId`). The last three are *labels* carried in
`classification[]`. An operation is the smallest event (one tool call); a code structure says what it
touched; a work category says what it was for.

## Schemes (multi-label unless stated)

| Scheme | Values | Basis today | Visual / music hint |
|---|---|---|---|
| work-category | research, planning, ui-design, frontend, backend, database, api, testing, debugging, security, performance, documentation, deployment-prep, tooling, localization, data-analysis | inferred from tool name, run-command signature and file paths (rules), 0.4–0.7 confidence; test/build/commit adapters give observed labels | hue, shape, instrument |
| language | javascript, typescript, gdscript, python, sql, html, css, markdown, json, yaml, shell, godot-scene, rust, other | observed from file extension (0.95) or Tree-sitter (1.0) | — |
| code-structure | function, method, class, component, loop, condition, import, variable, type, test-case, comment, query, markup | observed from Tree-sitter (0.95; 0.7 when the file has parse errors) | geometry |
| operation (single) | read, search, edit, create, run, browse, delegate, ask, plan, publish, schedule, test, build, commit, other | observed from the tool name; a run's command signature can refine it to test/build/commit | motion |
| task-type (single) | inspector, architect, builder, studio, mechanic, gatekeeper, laboratory (working modes) | inferred from the brief's wording (0.3–0.5); should become an LLM judgement at task start | section character |
| complexity (single) | S, M, L | declared by the estimator | — |

Language, purpose and structure are deliberately **not** exclusive: one `Edit` of `test/app.test.js` is
`language:javascript` + `work-category:testing` + `operation:edit`, and after parsing also
`code-structure:test-case`.

## Rules and their inputs

- `operationOfTool(toolName)`: fixed table; MCP tools default to `browse`.
- `classifyRunSignature(signature)`: regexes over a redacted command *signature* (first tokens and flags),
  e.g. `npm test`, `node --test`, `run_tests.tscn`, `git commit`, `psql`, `gh run`. The engine never stores
  the full command; the hook log does not even receive it.
- `classifyPath(path)`: extension → language (observed); directory conventions → categories (tests/, docs/,
  migrations/, server/, client/, i18n/, .github/, security/, perf/).
- `classifyTaskTitle(title)`: keyword rules for task-type, low confidence by design.
- Tree-sitter (`src/codeStructure.js`): node type → structure; call sites `test/it/describe` → test-case;
  `require()` → import; JSX → component. `touchedByLines` maps changed line numbers (from `git diff -U0`
  hunks) to the innermost enclosing named function/class/method, so a change that only alters a call still
  reports which function it touched.

## Proof of concept on real changes

Running `structure.js` over a real feature branch reports, per file, the structures added (new functions and test
cases) and the enclosing functions of every edited line. That is the "which functions did this task touch" signal a
workflow view needs.

## Extending

Add a value to `taxonomy.json` with its hints; add a rule (path, signature, or node type). Tests in
`packages/taxonomy/test/` check that every category has hints and that rules produce the expected labels.
Planned: TypeScript and GDScript grammars (`tree-sitter-typescript`, `tree-sitter-gdscript`), an LLM
judgement for task-type and ambiguous categories (recorded as `basis: declared`), and per-project
overrides (e.g. a project's own test-script naming convention).
