# prov-kit: models, providers, cost and local environment

Runs after `mods/infiniteoc` (it patches that mod's `/goal` registration, guidance marker and animations default).

| Feature | Where | Use |
| --- | --- | --- |
| Session budget | server plugin | `/budget 5` sets a limit in dollars, `/budget` shows it, `/budget off` removes it. At the limit tool calls are refused (the agent stops and reports) and an active `/goal` is paused. The limit is a note in the transcript, so it survives restarts. |
| Spend report | TUI | `/usage`: spend by day, project and provider, read from stored sessions (assistant and compaction message costs, subagents included). |
| Model routing | server plugin, `settings.json` | `/routing cheap provider/model` for explore, title and summary; `/routing strong provider/model` for the general and reviewer subagents. The main agent keeps the model you picked. `/routing` shows, `/routing off cheap` clears. |
| Provider fallback | server plugin | `/routing fallback provider/model`. On a 429 or 5xx (including a free tier's quota 429 or usage-limit error, which the runner itself never retries) the run retries on that model, then returns to the original at the end of the run. |
| Local models | TUI | `/local` probes Ollama (11434) and LM Studio (1234) on loopback and, after a confirmation, adds the provider with the existing safe writer (never overwrites an existing provider, keeps a backup). |
| Dev servers | TUI | `/serve`: start (PORT set to a free port), list, logs, stop. They keep running when tabs close and are stopped when InfiniteOC exits. |
| Free port | tool `free_port` | Guidance tells the agent to use it before starting any listener. |
| Strict providers | `core/src/tool/runtime.ts` patch | Every tool's object schema carries `required` (empty when nothing is): strict OpenAI-compatible proxies such as agentrouter rejected the whole request otherwise ("Invalid schema for function 'free_port': null is not of type array"). |
| Docker | server plugin | When the project has a compose file with running services, the agent is told and offers `docker compose exec`. |
| Env diff | tool `env_diff`, TUI `/envdiff` | Names missing, empty or extra in `.env` compared with `.env.example`. Never values. |
| Offline | server plugin, launcher | No usable network interface: the agent is told, the launcher skips the update check, and with `/routing local provider/model` the run uses that model. `INFINITEOC_OFFLINE=1|0` forces it. |
| Battery saver | launcher, TUI default | On battery (macOS `pmset`) the update check is skipped and animations default to off at launch (an explicit `animations` in the TUI config wins). `INFINITEOC_BATTERY=1|0` forces it. |

Settings keys (`settings.json`, other keys are preserved): `routing.cheap`, `routing.strong`, `fallback.model`, `local.model`, each `provider/model[#variant]`.

Files: `lib.ts` (pure helpers, copied into core and the TUI), `plugin.ts` (server plugin), `tui/*.tsx`, `test.mjs`. The launcher side is `src/netpower.mjs` plus three lines in `src/updater.mjs`.
