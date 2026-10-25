# InfiniteOC for iPhone

A native SwiftUI client for `infiniteoc serve`: follow your sessions live from the phone, send prompts and slash
commands (`/goal` and friends), steer or queue a message while a run is going, stop a run, and answer permission
prompts.

## Connect a computer

On the computer, start the API on an address the phone can reach (your LAN or tailnet):

```sh
OPENCODE_PASSWORD='a long password' infiniteoc serve --hostname 0.0.0.0 --port 4096
```

In the app, tap **+**, enter the address (`100.66.26.54:4096`) and the password, and **Test connection**. The
password is kept in the iOS Keychain. The serve API is plain HTTP, so use a network you trust, your tailnet, or
an HTTPS reverse proxy (an `https://` address works too).

## What it does

- **Computers**: several `infiniteoc serve` hosts; with one, the app opens it straight away.
- **Sessions**: newest first, with running, failed and stopped states and a badge for pending permission
  prompts. Search, archive, delete, start a new session in a folder (recent folders are offered).
- **Transcript**: replies stream in live from `GET /api/event`; reasoning, tool calls (input, output, errors),
  shell runs and context notes fold open on tap. Markdown with code blocks.
- **Composer**: prompts, `/command args` for the server's commands (suggested as you type), steer or queue while
  a run is going, stop.
- **Permissions**: Allow once, Always (confirmed: it saves a rule on the computer) or Deny, from the session
  list or inside the session.

## Build

`ios/project.yml` is an [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec (iOS 17+, no dependencies).
`.github/workflows/ios.yml` builds an unsigned `InfiniteOC.ipa` on every push that touches `ios/` and publishes it
as the `ios-latest` pre-release. Install it with your own Apple ID through Sideloadly, AltStore or Feather.

Locally on a Mac: `brew install xcodegen && cd ios && xcodegen generate && open InfiniteOC.xcodeproj`.
