import { relations } from "drizzle-orm";
import {
  users,
  magicLinks,
  projects,
  projectMembers,
  projectInvites,
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
