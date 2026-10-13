// InfiniteOC workflows: the per-workflow mailbox. Members are "main" (the agent that started the
// workflow) and the step ids; nothing outside one workflow can be addressed, so messages stay
// inside that session tree. Pure (no imports); the core plugin persists the list with the workflow.
// Written to packages/core/src/plugin/infiniteoc-wf-mailbox.ts by mods/workflows.

export type Message = { id: number; from: string; to: string; text: string; at: number; readBy: string[] }
export type Box = { messages: Message[] }
export type Limits = { maxMessages: number; maxChars: number }

export const LIMITS: Limits = { maxMessages: 200, maxChars: 4000 }
export const MAIN = "main"
export const ALL = "all"

/** Who receives a message: the addressee, or every member except the sender for "all". */
export const recipients = (message: Pick<Message, "from" | "to">, members: readonly string[]) =>
  message.to === ALL ? members.filter((member) => member !== message.from) : [message.to]

/** Adds a message after checking membership and limits; throws an Error the model can act on. */
export function send(
  box: Box,
  input: { from: string; to: string; text: string; members: readonly string[]; now?: number },
  limits: Limits = LIMITS,
): Message {
  const to = input.to.trim()
  const text = input.text.trim()
  if (!input.members.includes(input.from)) throw new Error(`${input.from} is not a member of this workflow.`)
  if (to !== ALL && !input.members.includes(to))
    throw new Error(`Unknown recipient "${to}". Members: ${input.members.join(", ")}, or "all".`)
  if (to === input.from) throw new Error("You cannot send a message to yourself.")
  if (!text) throw new Error("The message is empty.")
  if (text.length > limits.maxChars) throw new Error(`The message is longer than ${limits.maxChars} characters; send a summary.`)
  if (box.messages.length >= limits.maxMessages)
    throw new Error(`This workflow reached its limit of ${limits.maxMessages} messages.`)
  const message: Message = {
    id: (box.messages.at(-1)?.id ?? 0) + 1,
    from: input.from,
    to,
    text,
    at: input.now ?? Date.now(),
    readBy: [],
  }
  box.messages.push(message)
  return message
}

/** Messages for a member that it has not read yet, oldest first. */
export const unread = (box: Box, member: string, members: readonly string[]) =>
  box.messages.filter((message) => recipients(message, members).includes(member) && !message.readBy.includes(member))

export function markRead(box: Box, member: string, ids: readonly number[]) {
  for (const message of box.messages) if (ids.includes(message.id) && !message.readBy.includes(member)) message.readBy.push(member)
}

/** Reads and marks; what a read_messages call returns. */
export function take(box: Box, member: string, members: readonly string[]) {
  const messages = unread(box, member, members)
  markRead(
    box,
    member,
    messages.map((message) => message.id),
  )
  return messages
}

/** Messages a member sent or received, for history views. */
export const conversation = (box: Box, member: string, members: readonly string[]) =>
  box.messages.filter((message) => message.from === member || recipients(message, members).includes(member))

export const format = (messages: readonly Message[]) =>
  messages.map((message) => `#${message.id} from ${message.from} to ${message.to}: ${message.text}`).join("\n")
