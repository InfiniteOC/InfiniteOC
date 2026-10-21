# win-utf8

Windows shells print in the console's legacy code page (cp852 on a Polish system, cp1252, …) unless told
otherwise, and OpenCode's shell tool decodes their output as UTF-8, so every non-ASCII character in a
command's output came back as `?`.

One patch to `packages/core/src/shell/select.ts` `args()`:

| Shell | Before the command |
| --- | --- |
| PowerShell (`pwsh`, `powershell`) | `try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{};$OutputEncoding=[Text.UTF8Encoding]::new($false);` |
| `cmd` | `chcp 65001>nul 2>&1 & ` |

The command stays the last statement, so its exit code is the result's. `args()` is used by the shell tool and
custom commands; permission checks read the original command, not these arguments. Other shells (`bash`, `sh`,
Git Bash) are unchanged.
