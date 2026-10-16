# devices

Your other machines run InfiniteOC too: pair their `infiniteoc serve`/`host` addresses once
(`infiniteoc device add NAME URL`), then the `device` agent tool works on them and switches between
them mid-session (prompt sends work, waits for the result and reports back).

- Pairing is the user's CLI job; the tool only uses paired devices.
- Passwords live in 0600 key files, never in the registry or any output.
- Reads (list, sessions, read) run silently; open/prompt ask first.
