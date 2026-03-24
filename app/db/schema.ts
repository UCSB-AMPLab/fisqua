import {
  sqliteTable,
  text,
  integer,
  real,
  index,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  lastActiveAt: integer("last_active_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  githubId: text("github_id").unique(),
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
  archivedAt: integer("archived_at"),
});

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["lead", "cataloguer", "reviewer"] }).notNull(),
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

export const volumes = sqliteTable(
  "volumes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    referenceCode: text("reference_code").notNull(),
    manifestUrl: text("manifest_url").notNull(),
    pageCount: integer("page_count").notNull(),
    status: text("status", {
      enum: ["unstarted", "in_progress", "segmented", "sent_back", "reviewed", "approved"],
    })
      .notNull()
      .default("unstarted"),
    assignedTo: text("assigned_to").references(() => users.id),
    assignedReviewer: text("assigned_reviewer").references(() => users.id),
    reviewComment: text("review_comment"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("vol_project_idx").on(table.projectId),
    index("vol_status_idx").on(table.projectId, table.status),
  ]
);

export const volumePages = sqliteTable(
  "volume_pages",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    imageUrl: text("image_url").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    label: text("label"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("vp_volume_idx").on(table.volumeId),
    index("vp_volume_pos_idx").on(table.volumeId, table.position),
  ]
);

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id),
    parentId: text("parent_id"), // null = top-level entry
    position: integer("position").notNull(), // 0-based sibling order
    startPage: integer("start_page").notNull(), // 1-based page number
    startY: real("start_y").notNull().default(0), // 0.0 = top of page
    endPage: integer("end_page"), // explicit for children, null for top-level
    endY: real("end_y"), // fraction 0-1, null for top-level
    type: text("type", {
      enum: ["item", "blank", "front_matter", "back_matter"],
    }), // nullable: unset by default
    title: text("title"),
    modifiedBy: text("modified_by").references(() => users.id),
    // Description status and assignment
    descriptionStatus: text("description_status", {
      enum: ["unassigned", "assigned", "in_progress", "described", "reviewed", "approved", "sent_back"],
    }).default("unassigned"),
    assignedDescriber: text("assigned_describer").references(() => users.id),
    assignedDescriptionReviewer: text("assigned_description_reviewer").references(() => users.id),
    // Description metadata fields
    translatedTitle: text("translated_title"),
    resourceType: text("resource_type", {
      enum: ["texto", "imagen", "cartografico", "mixto"],
    }),
    dateExpression: text("date_expression"),
    dateStart: text("date_start"),
    dateEnd: text("date_end"),
    extent: text("extent"),
    scopeContent: text("scope_content"),
    language: text("language"),
    descriptionNotes: text("description_notes"),
    internalNotes: text("internal_notes"),
    descriptionLevel: text("description_level").default("item"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("entry_volume_idx").on(table.volumeId),
    index("entry_parent_idx").on(table.parentId),
    index("entry_volume_pos_idx").on(table.volumeId, table.position),
  ]
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull().references(() => entries.id),
    parentId: text("parent_id"), // null = top-level, references comments.id for nesting
    authorId: text("author_id").notNull().references(() => users.id),
    authorRole: text("author_role", {
      enum: ["cataloguer", "reviewer", "lead"],
    }).notNull(),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("comment_entry_idx").on(table.entryId),
    index("comment_parent_idx").on(table.parentId),
  ]
);

export const resegmentationFlags = sqliteTable(
  "resegmentation_flags",
  {
    id: text("id").primaryKey(),
    volumeId: text("volume_id").notNull().references(() => volumes.id),
    reportedBy: text("reported_by").notNull().references(() => users.id),
    entryId: text("entry_id").notNull().references(() => entries.id),
    problemType: text("problem_type", {
      enum: ["incorrect_boundaries", "merged_documents", "split_document", "missing_pages", "other"],
    }).notNull(),
    affectedEntryIds: text("affected_entry_ids").notNull(), // JSON array of entry IDs
    description: text("description").notNull(),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("reseg_volume_idx").on(table.volumeId)]
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    volumeId: text("volume_id").references(() => volumes.id),
    event: text("event", {
      enum: [
        "login",
        "volume_opened",
        "status_changed",
        "review_submitted",
        "assignment_changed",
        "description_status_changed",
        "description_assignment_changed",
        "resegmentation_flagged",
        "comment_added",
      ],
    }).notNull(),
    detail: text("detail"), // JSON blob for event-specific data
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("al_user_idx").on(table.userId),
    index("al_project_idx").on(table.projectId),
    index("al_created_idx").on(table.createdAt),
  ]
);
