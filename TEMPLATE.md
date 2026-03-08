# Template Customization Guide

This template gives you a working Cloudflare Workers app with authentication,
project management, and role-based access. Clone it, configure it, and start
building your domain-specific features.

## Getting Started

```bash
git clone <this-repo> my-app
cd my-app
npm install
```

Create a `.dev.vars` file for local secrets:

```
RESEND_API_KEY=re_your_key_here
```

You can get a Resend API key at [resend.com](https://resend.com). This is
required for magic link login emails.

Set your app identity in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "APP_NAME": "My App",
  "SENDER_EMAIL": "noreply@example.com"
}
```

Initialize the local database and start the dev server:

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

## App Identity

App name and sender email are configured as environment variables in
`wrangler.jsonc` under the `vars` section. These flow through
`app/lib/config.server.ts`, which is the single source of truth for app
identity across the codebase.

| Variable | Default | Used in |
|----------|---------|---------|
| `APP_NAME` | `"My App"` | Page titles, email subjects, email body text |
| `SENDER_EMAIL` | `"noreply@example.com"` | Email `from` field |

The `getAppConfig()` function in `app/lib/config.server.ts` reads these
variables and provides fallback defaults, so the template works out of the box
without any configuration.

## Adding Domain Routes

Domain routes live inside the project layout block in `app/routes.ts`. Look for
the extension point marker:

```typescript
layout("routes/_auth.projects.$id.tsx", [
  { path: "projects/:id", file: "routes/_auth.projects.$id._index.tsx" },
  route("projects/:id/settings", "routes/_auth.projects.$id.settings.tsx"),
  route("projects/:id/members", "routes/_auth.projects.$id.members.tsx"),
  // --- EXTENSION POINT --- add your domain-specific routes below
  route("projects/:id/items", "routes/_auth.projects.$id.items.tsx"),
]),
```

Routes inside this layout block automatically inherit authentication and
project membership checks from the parent layout (`_auth.projects.$id.tsx`).
You do not need to add auth logic to individual route loaders.

**File naming convention:** `_auth.projects.$id.{feature}.tsx`

The `_auth.` prefix ensures the route is nested inside the authenticated
layout. The `$id` segment captures the project ID parameter.

See `app/routes/_auth.projects.$id.items.tsx` for a working placeholder
example. Replace it with your own domain feature.

To add a navigation tab for your route, add a `NavLink` to the project layout
in `app/routes/_auth.projects.$id.tsx`, following the pattern used by the
existing Settings, Members, and Items tabs.

## Extending the Schema

Add Drizzle tables after the extension point marker in `app/db/schema.ts`
(line 74):

```typescript
// --- EXTENSION POINT --- add your domain-specific tables below

export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  status: text("status", { enum: ["draft", "review", "published"] })
    .notNull()
    .default("draft"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

After changing the schema, generate and apply a migration:

```bash
npx wrangler d1 migrations create DB add-items-table
npx wrangler d1 migrations apply DB --local
```

Migrations are stored in the `drizzle/` directory.

## Customizing Roles

The template defines three roles in `app/db/schema.ts` on the
`projectMembers` table:

```typescript
role: text("role", { enum: ["lead", "member", "reviewer"] }).notNull(),
```

Role-checking logic lives in `app/lib/permissions.server.ts`. The
`requireProjectRole()` function accepts an array of allowed roles and throws
a 403 if the user does not have one of them. Admins bypass role checks
entirely.

To change role names:

1. Update the enum in `app/db/schema.ts` on the `projectMembers` table
2. Update role checks in `app/lib/permissions.server.ts`
3. Update UI labels in route components (member list, invite forms)
4. Create a migration for the schema change

## Email Templates

Email functions live in `app/lib/email.server.ts`. The template includes three
email types:

- `sendMagicLinkEmail()` -- login magic links
- `sendNewUserInviteEmail()` -- invitations for new users
- `sendExistingUserInviteEmail()` -- notifications for existing users added to a project

All email functions accept an `appConfig: AppConfig` parameter (from
`app/lib/config.server.ts`) as their last argument. This provides the app name
and sender email. Emails are sent via the [Resend](https://resend.com) SDK.

To customize email content, edit the HTML templates in each function. The
`appConfig.appName` and `appConfig.senderEmail` values are available for
personalization.

## Project Settings

The `projects` table has two flexible columns for project-level configuration:

- `conventions` (text) -- intended for markdown guidelines or project-specific
  instructions. Rendered on the settings page.
- `settings` (text) -- intended for structured JSON configuration. Validated
  on save to prevent malformed data.

The settings UI is at `/projects/:id/settings`. See
`app/routes/_auth.projects.$id.settings.tsx` for the form pattern.

## Infrastructure vs Extension Points

The codebase uses single-line comment markers to separate infrastructure
(do not modify) from extension points (modify when customizing):

```
// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending
// --- EXTENSION POINT --- add your domain-specific [thing] here/below
```

**Infrastructure files (do not modify):**

| File | Purpose |
|------|---------|
| `app/sessions.server.ts` | Cookie-based session management |
| `app/context.ts` | React Router context (user, env) |
| `app/lib/config.server.ts` | App identity configuration |
| `app/middleware/auth.server.ts` | Authentication middleware |
| `app/lib/permissions.server.ts` | Role and permission checks |

**Extension point files (modify when customizing):**

| File | What to add |
|------|-------------|
| `app/db/schema.ts` | Domain-specific Drizzle tables |
| `app/routes.ts` | Domain-specific routes |
| `app/lib/projects.server.ts` | Domain-specific project logic |

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

Set secrets for production:

```bash
npx wrangler secret put RESEND_API_KEY
```

The `wrangler.jsonc` file configures D1 database and R2 storage bindings.
Update `database_name`, `database_id`, and `bucket_name` for your production
environment.

For production D1, apply migrations with:

```bash
npx wrangler d1 migrations apply DB --remote
```
