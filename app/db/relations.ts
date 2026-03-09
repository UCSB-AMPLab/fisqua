import { relations } from "drizzle-orm";
import {
  users,
  magicLinks,
  projects,
  projectMembers,
  projectInvites,
  volumes,
  entries,
  activityLog,
} from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  magicLinks: many(magicLinks),
  projectMembers: many(projectMembers),
  projectInvites: many(projectInvites),
  createdProjects: many(projects),
}));

export const magicLinksRelations = relations(magicLinks, ({ one }) => ({
  user: one(users, { fields: [magicLinks.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  creator: one(users, { fields: [projects.createdBy], references: [users.id] }),
  members: many(projectMembers),
  invites: many(projectInvites),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const projectInvitesRelations = relations(projectInvites, ({ one }) => ({
  project: one(projects, { fields: [projectInvites.projectId], references: [projects.id] }),
  inviter: one(users, { fields: [projectInvites.invitedBy], references: [users.id] }),
}));

export const volumesRelations = relations(volumes, ({ many }) => ({
  entries: many(entries),
}));

export const entriesRelations = relations(entries, ({ one, many }) => ({
  volume: one(volumes, { fields: [entries.volumeId], references: [volumes.id] }),
  parent: one(entries, {
    fields: [entries.parentId],
    references: [entries.id],
    relationName: "entryParent",
  }),
  children: many(entries, { relationName: "entryParent" }),
}));

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  user: one(users, { fields: [activityLog.userId], references: [users.id] }),
  project: one(projects, {
    fields: [activityLog.projectId],
    references: [projects.id],
  }),
  volume: one(volumes, {
    fields: [activityLog.volumeId],
    references: [volumes.id],
  }),
}));
