// The connector catalog. Every remote URL was checked (2026-10) to answer as an MCP server: "oauth" ones are
// OAuth-protected and register clients themselves (DCR or CIMD), so `infiniteoc mcp auth ID` or /apps signs in
// once; "none" ones answered tools/list and a tool call without credentials. Local commands come from each
// project's own README. Community packages that receive a secret are pinned to an exact version or commit.
// Left out on purpose: Slack, HubSpot, Box, Discord's hosted server, PagerDuty and Render (their servers accept
// only pre-registered clients), remote Google Cloud endpoints (they need an hourly-expiring Google token; the
// local Google servers below refresh gcloud credentials themselves), and PyPI's `telegram-mcp`, which is not
// the Telegram server below (its maintainers warn that it is an unrelated project).
//
// Fields: id, name, category, description, kind "remote" | "local".
//   remote: url, auth "oauth" | "token" | "none", protocol?, header? (token header name; default Authorization: Bearer)
//   local: command, needs (the launcher that must be on PATH), platform? ("darwin" = macOS only)
//   vars: [{ name, help, secret?, optional?, arg? }] — values the server needs; arg: appended to the command
//   setup: one-time steps outside InfiniteOC, shown after connecting

const oauth = (id, name, category, url, description, extra = {}) => ({ id, name, category, kind: "remote", auth: "oauth", url, description, ...extra })
const open = (id, name, category, url, description) => ({ id, name, category, kind: "remote", auth: "none", url, description })
const local = (id, name, category, command, description, extra = {}) => ({ id, name, category, kind: "local", command, needs: command[0], description, ...extra })
const cf = (sub, name, description) => oauth(`cloudflare-${sub}`, `Cloudflare ${name}`, "Cloudflare", `https://${sub}.mcp.cloudflare.com/mcp`, description)
const GCLOUD = "Install the gcloud CLI, then run: gcloud auth login && gcloud auth application-default login"

export const CATEGORIES = ["Code & delivery", "Cloud", "Cloudflare", "Google", "Apple", "Chat & messaging", "Work & planning", "Design & content", "Data & analytics", "Docs & search", "Local tools"]

export const CATALOG = [
  // ---- Code & delivery
  oauth("github", "GitHub", "Code & delivery", "https://api.githubcopilot.com/mcp/", "Repositories, issues, pull requests, Actions", {
    auth: "token",
    vars: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", help: "a fine-grained personal access token: https://github.com/settings/personal-access-tokens", secret: true }],
  }),
  oauth("gitlab", "GitLab", "Code & delivery", "https://gitlab.com/api/v4/mcp", "Projects, issues, merge requests, pipelines (gitlab.com)"),
  oauth("vercel", "Vercel", "Code & delivery", "https://mcp.vercel.com", "Deployments, projects, logs"),
  oauth("netlify", "Netlify", "Code & delivery", "https://netlify-mcp.netlify.app/mcp", "Sites, deploys, forms, environment"),
  oauth("railway", "Railway", "Code & delivery", "https://mcp.railway.com", "Projects, services, deployments, logs"),
  oauth("supabase", "Supabase", "Code & delivery", "https://mcp.supabase.com/mcp", "Projects, SQL, migrations, edge functions"),
  oauth("neon", "Neon", "Code & delivery", "https://mcp.neon.tech/mcp", "Serverless Postgres branches and queries"),
  oauth("prisma", "Prisma Postgres", "Code & delivery", "https://mcp.prisma.io/mcp", "Databases, migrations, backups"),
  oauth("sentry", "Sentry", "Code & delivery", "https://mcp.sentry.dev/mcp", "Errors, issues, traces"),
  oauth("semgrep", "Semgrep", "Code & delivery", "https://mcp.semgrep.ai/mcp", "Code scanning findings and rules"),
  oauth("postman", "Postman", "Code & delivery", "https://mcp.postman.com/mcp", "Collections, environments, API specs"),
  oauth("jam", "Jam", "Code & delivery", "https://mcp.jam.dev/mcp", "Bug reports with console, network and repro steps"),
  oauth("stripe", "Stripe", "Code & delivery", "https://mcp.stripe.com", "Payments, customers, products, docs"),
  oauth("paypal", "PayPal", "Code & delivery", "https://mcp.paypal.com/mcp", "Invoices, orders, transactions"),
  oauth("square", "Square", "Code & delivery", "https://mcp.squareup.com/sse", "Payments, catalog, orders, customers", { protocol: "sse" }),
  local("shopify-dev", "Shopify Dev", "Code & delivery", ["npx", "-y", "@shopify/dev-mcp@latest"], "Shopify API docs, GraphQL schema, Liquid validation"),

  // ---- Cloud
  local("aws", "AWS", "Cloud", ["uvx", "awslabs.aws-api-mcp-server@latest"], "Any AWS CLI command with your configured AWS credentials", {
    vars: [{ name: "AWS_REGION", help: "default region, e.g. us-east-1", optional: true }, { name: "READ_OPERATIONS_ONLY", help: "true to allow read-only commands only", optional: true }],
    setup: "Uses your AWS credentials (aws configure / AWS_PROFILE)",
  }),
  local("azure", "Azure", "Cloud", ["npx", "-y", "@azure/mcp@latest", "server", "start"], "Azure resources, storage, databases, monitoring", { setup: "Sign in with the Azure CLI: az login" }),
  local("kubernetes", "Kubernetes", "Cloud", ["npx", "-y", "kubernetes-mcp-server@latest"], "Pods, deployments, logs, Helm, via your kubeconfig"),

  // ---- Cloudflare (all OAuth; the first covers the whole Cloudflare API)
  oauth("cloudflare", "Cloudflare API", "Cloudflare", "https://mcp.cloudflare.com/mcp", "The entire Cloudflare API: zones, DNS, Workers, R2, D1, KV, WAF, ..."),
  open("cloudflare-docs", "Cloudflare docs", "Cloudflare", "https://docs.mcp.cloudflare.com/mcp", "Cloudflare developer documentation (no sign-in)"),
  cf("bindings", "Workers bindings", "Build Workers with KV, R2, D1, Durable Objects, Queues"),
  cf("builds", "Workers builds", "Workers build history, logs and status"),
  cf("observability", "observability", "Workers logs and analytics"),
  cf("containers", "containers", "A sandboxed container to run code in"),
  cf("browser", "browser rendering", "Fetch pages, screenshots and markdown through Browser Rendering"),
  cf("logs", "Logpush", "Logpush jobs and health"),
  cf("ai-gateway", "AI Gateway", "AI Gateway logs, prompts and responses"),
  cf("autorag", "AI Search", "Search your AutoRAG / AI Search indexes"),
  cf("auditlogs", "audit logs", "Account audit logs and reports"),
  cf("dns-analytics", "DNS analytics", "DNS performance and configuration insights"),
  cf("dex", "Digital Experience", "Zero Trust Digital Experience Monitoring"),
  cf("casb", "CASB", "Cloud app security findings (Zero Trust)"),
  cf("graphql", "GraphQL analytics", "Cloudflare's GraphQL analytics API"),
  cf("radar", "Radar", "Internet traffic, attacks and trends from Cloudflare Radar"),

  // ---- Google (local servers use gcloud application-default credentials, which refresh themselves)
  local("gcloud", "Google Cloud (gcloud)", "Google", ["npx", "-y", "@google-cloud/gcloud-mcp"], "Run gcloud commands across your Google Cloud projects", { setup: GCLOUD }),
  local("google-cloud-run", "Cloud Run", "Google", ["npx", "-y", "@google-cloud/cloud-run-mcp"], "Deploy and manage Cloud Run services", {
    vars: [{ name: "GOOGLE_CLOUD_PROJECT", help: "default project ID", optional: true }],
    setup: GCLOUD,
  }),
  local("google-storage", "Cloud Storage", "Google", ["npx", "-y", "@google-cloud/storage-mcp"], "Buckets and objects in Google Cloud Storage", {
    vars: [{ name: "GOOGLE_CLOUD_PROJECT", help: "default project ID", optional: true }],
    setup: GCLOUD,
  }),
  local("google-observability", "Cloud Logging & Monitoring", "Google", ["npx", "-y", "@google-cloud/observability-mcp"], "Logs, metrics, traces and error reporting", { setup: GCLOUD }),
  local("bigquery", "BigQuery", "Google", ["npx", "-y", "@toolbox-sdk/server", "--prebuilt", "bigquery", "--stdio"], "Datasets, schemas and SQL in BigQuery (MCP Toolbox)", {
    vars: [{ name: "BIGQUERY_PROJECT", help: "Google Cloud project ID to query" }],
    setup: GCLOUD,
  }),
  local("firebase", "Firebase", "Google", ["npx", "-y", "firebase-tools@latest", "mcp"], "Firestore, Auth, Hosting, Remote Config, Crashlytics", { setup: "Sign in once: npx firebase-tools login" }),
  local("google-analytics", "Google Analytics", "Google", ["uvx", "analytics-mcp"], "GA4 reports, realtime data and property settings", {
    vars: [{ name: "GOOGLE_PROJECT_ID", help: "Google Cloud project with the Analytics APIs enabled", optional: true }],
    setup: "gcloud auth application-default login --scopes https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform",
  }),
  local("google-workspace", "Google Workspace", "Google", ["uvx", "workspace-mcp@2.1.0", "--tool-tier", "core"], "Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Chat", {
    vars: [
      { name: "GOOGLE_OAUTH_CLIENT_ID", help: "OAuth client ID (Desktop app) from https://console.cloud.google.com/apis/credentials" },
      { name: "GOOGLE_OAUTH_CLIENT_SECRET", help: "that OAuth client's secret", secret: true },
    ],
    setup: "Enable the Gmail/Drive/Calendar/... APIs in that project; the first tool call opens Google sign-in in your browser",
  }),
  oauth("google-maps", "Google Maps", "Google", "https://mapstools.googleapis.com/mcp", "Places, routes and weather grounded in Google Maps", {
    auth: "token",
    header: "X-Goog-Api-Key",
    vars: [{ name: "GOOGLE_MAPS_API_KEY", help: "a Maps Platform API key: https://console.cloud.google.com/google/maps-apis/credentials", secret: true }],
  }),
  local("google-maps-code-assist", "Maps code assist", "Google", ["npx", "-y", "@googlemaps/code-assist-mcp@latest"], "Google Maps Platform docs and code samples"),
  oauth("google-developer-docs", "Google developer docs", "Google", "https://developerknowledge.googleapis.com/mcp", "Search official Google developer documentation", {
    auth: "token",
    header: "X-Goog-Api-Key",
    vars: [{ name: "GOOGLE_DEVELOPER_KNOWLEDGE_API_KEY", help: "an API key with the Developer Knowledge API enabled", secret: true }],
  }),
  local("chrome-devtools", "Chrome DevTools", "Google", ["npx", "-y", "chrome-devtools-mcp@latest"], "Inspect and debug a live Chrome: console, network, performance"),

  // ---- Apple (macOS)
  local("xcode", "Xcode", "Apple", ["xcrun", "mcpbridge"], "Xcode's own tools: build, test, previews, docs search (Xcode 26.3+)", {
    platform: "darwin",
    setup: "Xcode → Settings → Intelligence → Model Context Protocol → Xcode Tools: on; keep a project open (macOS 26.2+)",
  }),
  local("xcodebuild", "XcodeBuildMCP", "Apple", ["npx", "-y", "xcodebuildmcp@latest", "mcp"], "Build, run and test iOS/macOS apps on simulators and devices", { platform: "darwin" }),
  local("apple-apps", "Apple apps", "Apple", ["bunx", "@dhravya/apple-mcp@0.2.7"], "Notes, Reminders, Calendar, Contacts, Mail, Messages, Maps", {
    platform: "darwin",
    setup: "Needs bun; allow the Automation prompts macOS shows the first time",
  }),
  local("apple-docs", "Apple developer docs", "Apple", ["npx", "-y", "@kimsungwhee/apple-docs-mcp"], "Apple documentation, SwiftUI/UIKit APIs, WWDC sessions"),
  local("macos-automator", "macOS Automator", "Apple", ["npx", "-y", "--package", "@steipete/macos-automator-mcp", "macos-automator-mcp"], "Run AppleScript and JXA to drive any Mac app", {
    platform: "darwin",
    setup: "Needs Node 24+; allow Automation/Accessibility when macOS asks",
  }),

  // ---- Chat & messaging
  local("imessage", "iMessage", "Chat & messaging", ["uvx", "mac-messages-mcp@1.1.0"], "Read and send iMessage/SMS from the Messages app", {
    platform: "darwin",
    setup: "Grant Full Disk Access (and Contacts) to the terminal app that runs InfiniteOC; Messages must be signed in",
  }),
  local("discord", "Discord", "Chat & messaging", ["npx", "-y", "mcp-discord@1.3.4"], "Read and send messages, manage channels, threads, reactions, webhooks", {
    vars: [{ name: "DISCORD_TOKEN", help: "your bot's token: https://discord.com/developers/applications → Bot → Reset Token", secret: true }],
    setup: "In the Developer Portal enable the Message Content, Server Members and Presence intents, then invite the bot to your server",
  }),
  local("telegram", "Telegram", "Chat & messaging", ["uvx", "--from", "git+https://github.com/chigwell/telegram-mcp.git@c1e3dc4adff27a6935852309bf0218f1ac4cd766", "telegram-mcp"], "Your Telegram account: chats, messages, search, groups, contacts", {
    vars: [
      { name: "TELEGRAM_API_ID", help: "api_id from https://my.telegram.org → API development tools" },
      { name: "TELEGRAM_API_HASH", help: "api_hash from the same page", secret: true },
      { name: "TELEGRAM_SESSION_STRING", help: "from: uvx --from git+https://github.com/chigwell/telegram-mcp.git@c1e3dc4adff27a6935852309bf0218f1ac4cd766 telegram-mcp-generate-session --qr", secret: true },
    ],
    setup: "The session string signs in as you: generate it with the command in its prompt (QR login) and treat it like a password",
  }),

  // ---- Work & planning
  oauth("linear", "Linear", "Work & planning", "https://mcp.linear.app/mcp", "Issues, projects, cycles"),
  oauth("atlassian", "Jira & Confluence", "Work & planning", "https://mcp.atlassian.com/v1/mcp", "Jira issues and Confluence pages"),
  oauth("asana", "Asana", "Work & planning", "https://mcp.asana.com/sse", "Tasks, projects, goals", { protocol: "sse" }),
  oauth("clickup", "ClickUp", "Work & planning", "https://mcp.clickup.com/mcp", "Tasks, docs, spaces"),
  oauth("monday", "monday.com", "Work & planning", "https://mcp.monday.com/mcp", "Boards, items, updates"),
  oauth("todoist", "Todoist", "Work & planning", "https://ai.todoist.net/mcp", "Tasks, projects, labels"),
  oauth("notion", "Notion", "Work & planning", "https://mcp.notion.com/mcp", "Pages, databases, search"),
  oauth("airtable", "Airtable", "Work & planning", "https://mcp.airtable.com/mcp", "Bases, tables, records"),
  oauth("miro", "Miro", "Work & planning", "https://mcp.miro.com/", "Boards, sticky notes, diagrams"),
  oauth("dropbox", "Dropbox", "Work & planning", "https://mcp.dropbox.com/mcp", "Files and folders in your Dropbox"),
  oauth("intercom", "Intercom", "Work & planning", "https://mcp.intercom.com/mcp", "Conversations, contacts, help center"),
  oauth("gitbook", "GitBook", "Work & planning", "https://mcp.gitbook.com/mcp", "Spaces and pages in your GitBook"),
  oauth("zapier", "Zapier", "Work & planning", "https://mcp.zapier.com/api/mcp/mcp", "Actions in the apps connected to your Zapier account"),
  oauth("apify", "Apify", "Work & planning", "https://mcp.apify.com", "Run Apify actors: scrapers and automations"),

  // ---- Design & content
  oauth("figma", "Figma", "Design & content", "https://mcp.figma.com/mcp", "Design context, variables, screenshots"),
  oauth("canva", "Canva", "Design & content", "https://mcp.canva.com/mcp", "Designs, assets, exports"),
  oauth("webflow", "Webflow", "Design & content", "https://mcp.webflow.com/mcp", "Sites, CMS collections, pages"),
  oauth("wix", "Wix", "Design & content", "https://mcp.wix.com/mcp", "Sites, CMS, stores, bookings"),
  oauth("sanity", "Sanity", "Design & content", "https://mcp.sanity.io", "Content Lake documents, schemas, GROQ"),

  // ---- Data & analytics
  oauth("posthog", "PostHog", "Data & analytics", "https://mcp.posthog.com/mcp", "Product analytics, feature flags, experiments"),
  oauth("amplitude", "Amplitude", "Data & analytics", "https://mcp.amplitude.com/mcp", "Charts, cohorts, experiments"),
  oauth("mixpanel", "Mixpanel", "Data & analytics", "https://mcp.mixpanel.com/mcp", "Events, funnels, retention"),
  oauth("grafana", "Grafana Cloud", "Data & analytics", "https://mcp.grafana.com/mcp", "Dashboards, metrics, logs, incidents"),
  oauth("honeycomb", "Honeycomb", "Data & analytics", "https://mcp.honeycomb.io/mcp", "Observability queries and traces"),
  local("postgres", "PostgreSQL", "Data & analytics", ["npx", "-y", "@modelcontextprotocol/server-postgres"], "Read-only SQL against a database", {
    vars: [{ name: "DATABASE_URL", help: "postgres://user:password@host/db", secret: true, arg: true }],
  }),
  local("mongodb", "MongoDB", "Data & analytics", ["npx", "-y", "mongodb-mcp-server@latest", "--readOnly"], "Read-only queries, schemas and indexes", {
    vars: [{ name: "MDB_MCP_CONNECTION_STRING", help: "mongodb://... or mongodb+srv://...", secret: true }],
  }),

  // ---- Docs & search
  open("context7", "Context7", "Docs & search", "https://mcp.context7.com/mcp", "Current library docs by version"),
  open("deepwiki", "DeepWiki", "Docs & search", "https://mcp.deepwiki.com/mcp", "Docs and Q&A for any public GitHub repository"),
  open("microsoft-learn", "Microsoft Learn", "Docs & search", "https://learn.microsoft.com/api/mcp", "Microsoft and Azure documentation and code samples"),
  open("aws-knowledge", "AWS Knowledge", "Docs & search", "https://knowledge-mcp.global.api.aws", "AWS documentation, regional availability, guidance"),
  open("huggingface", "Hugging Face", "Docs & search", "https://huggingface.co/mcp", "Models, datasets, Spaces, papers"),
  open("socket", "Socket", "Docs & search", "https://mcp.socket.dev/", "Dependency security and quality scores"),
  open("exa", "Exa", "Docs & search", "https://mcp.exa.ai/mcp", "Web search and page fetch (free tier is rate limited)"),
  oauth("tavily", "Tavily", "Docs & search", "https://mcp.tavily.com/mcp", "Web search, extract and crawl"),
  local("brave-search", "Brave Search", "Docs & search", ["npx", "-y", "@brave/brave-search-mcp-server", "--transport", "stdio"], "Web, news, image and local search", {
    vars: [{ name: "BRAVE_API_KEY", help: "an API key from https://api-dashboard.search.brave.com", secret: true }],
  }),

  // ---- Local tools
  local("playwright", "Playwright browser", "Local tools", ["npx", "-y", "@playwright/mcp@latest"], "Drive a real browser: navigate, click, fill, snapshot"),
  local("blender", "Blender", "Local tools", ["uvx", "blender-mcp"], "Control a running Blender (needs its add-on enabled)"),
  local("obsidian", "Obsidian", "Local tools", ["uvx", "mcp-obsidian@0.2.3"], "Read and write notes in your vault", {
    vars: [{ name: "OBSIDIAN_API_KEY", help: "the API key of Obsidian's Local REST API plugin", secret: true }],
  }),
]
