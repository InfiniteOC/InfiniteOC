// InfiniteOC accounts: `auth rename [integration] [account] [name]`. Written to
// packages/cli/src/commands/handlers/auth/rename.ts by mods/accounts; modelled on upstream's auth switch.
import { intro, outro, spinner, text } from "@clack/prompts"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { handlePromptErrors, prompt, requireInteractive } from "../../../ui/prompt"
import { createClient, loadIntegrations, request } from "./shared"
import { chooseCredential, chooseIntegration } from "./account"

export default Runtime.handler(
  Commands.commands.auth.commands.rename,
  Effect.fn("cli.auth.rename")((input) =>
    rename({
      target: Option.getOrUndefined(input.target),
      credential: Option.getOrUndefined(input.credential),
      name: Option.getOrUndefined(input.name),
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    }).pipe(handlePromptErrors),
  ),
)

// Same rule as the TUI (accounts-lib validateLabel): trimmed, 1-64 characters, no control characters.
function checkName(value: string | undefined) {
  const label = (value ?? "").trim()
  if (!label) return "Name cannot be empty"
  if (/[\u0000-\u001f\u007f]/.test(label)) return "Name cannot contain control characters"
  if (Array.from(label).length > 64) return "Name must be at most 64 characters"
  return undefined
}

const rename = Effect.fn("cli.auth.rename.run")(function* (input: {
  target?: string
  credential?: string
  name?: string
  server?: string
  standalone: boolean
}) {
  if (!input.target)
    yield* requireInteractive("Pass an integration ID or name when running without an interactive terminal")
  if (!input.credential)
    yield* requireInteractive("Pass a credential ID or label when running without an interactive terminal")
  if (input.name === undefined) yield* requireInteractive("Pass the new name when running without an interactive terminal")
  intro("Rename account")
  const client = yield* createClient({ server: input.server, standalone: input.standalone })
  const integrations = yield* loadIntegrations(client)
  const integration = yield* chooseIntegration(integrations, input.target)
  const credentialID = yield* chooseCredential(integration, "rename", input.credential)
  const name =
    input.name ??
    (yield* prompt<string>(() => text({ message: "New account name", validate: (value) => checkName(value) })))
  const invalid = checkName(name)
  if (invalid) return yield* Effect.fail(new Error(invalid))
  const progress = spinner()
  progress.start("Renaming account...")
  yield* request((signal) => client.credential.update({ credentialID, label: name.trim() }, { signal })).pipe(
    Effect.tap(() => Effect.sync(() => progress.stop(`Renamed ${integration.name} account to ${name.trim()}`))),
    Effect.tapCause(() => Effect.sync(() => progress.stop("Failed to rename account", 1))),
  )
  outro("Done")
})
