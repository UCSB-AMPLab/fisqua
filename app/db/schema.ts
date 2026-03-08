import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id").notNull().references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("magic_links_token_idx").on(table.token),
    index("magic_links_expires_idx").on(table.expiresAt),
  ]
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  conventions: text("conventions"),       // markdown guidelines
  settings: text("settings"),             // JSON blob for app-specific config
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["lead", "member", "reviewer"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("pm_project_idx").on(table.projectId),
    index("pm_user_idx").on(table.userId),
    index("pm_project_user_idx").on(table.projectId, table.userId),
  ]
);

export const projectInvites = sqliteTable("project_invites", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  email: text("email").notNull(),
  roles: text("roles").notNull(),
  invitedBy: text("invited_by").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  acceptedAt: integer("accepted_at"),
  createdAt: integer("created_at").notNull(),
});

// --- EXTENSION POINT --- add your domain-specific tables below
