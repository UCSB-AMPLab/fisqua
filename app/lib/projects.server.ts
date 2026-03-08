// --- EXTENSION POINT --- add your domain-specific project logic here

import { eq, and } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  projects,
  projectMembers,
} from "../db/schema";

/**
 * Schema for project creation form validation.
 */
export function validateProjectForm(data: {
  name: string;
  description: string;
}): { success: true; data: typeof data } | { success: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!data.name || data.name.trim().length === 0) {
    errors.name = "Project name is required";
  } else if (data.name.trim().length > 200) {
    errors.name = "Project name must be 200 characters or less";
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      name: data.name.trim(),
      description: data.description?.trim() || "",
    },
  };
}

/**
 * Creates a project and adds the creator as a "lead" member.
 */
export async function createProject(
  db: DrizzleD1Database<any>,
  data: { name: string; description: string | null },
  creatorId: string
) {
  const now = Date.now();
  const projectId = crypto.randomUUID();

  const project = {
    id: projectId,
    name: data.name,
    description: data.description || null,
    createdBy: creatorId,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(project);

  // Add creator as lead
  await db.insert(projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId: creatorId,
    role: "lead",
    createdAt: now,
  });

  return project;
}

/**
 * Fetches all projects for a user, with their roles.
 * Admins see all projects.
 */
export async function getUserProjects(
  db: DrizzleD1Database<any>,
  userId: string,
  isAdmin: boolean
) {
  if (isAdmin) {
    // Admin sees all projects
    const allProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .all();

    // Get admin's memberships for role display
    const memberships = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId))
      .all();

    const membershipMap = new Map<string, string[]>();
    for (const m of memberships) {
      const roles = membershipMap.get(m.projectId) || [];
      roles.push(m.role);
      membershipMap.set(m.projectId, roles);
    }

    return allProjects.map((p) => ({
      ...p,
      roles: membershipMap.get(p.id) || ["admin"],
    }));
  }

  // Regular user -- only projects with membership
  const userMemberships = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId))
    .all();

  if (userMemberships.length === 0) {
    return [];
  }

  // Group roles by project
  const roleMap = new Map<string, string[]>();
  for (const m of userMemberships) {
    const roles = roleMap.get(m.projectId) || [];
    roles.push(m.role);
    roleMap.set(m.projectId, roles);
  }

  const projectIds = Array.from(roleMap.keys());

  // Fetch project details
  const userProjects = [];
  for (const projectId of projectIds) {
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .all();

    if (rows.length > 0) {
      userProjects.push({
        ...rows[0],
        roles: roleMap.get(projectId) || [],
      });
    }
  }

  return userProjects;
}

/**
 * Fetches a single project by ID.
 */
export async function getProject(
  db: DrizzleD1Database<any>,
  projectId: string
) {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      conventions: projects.conventions,
      settings: projects.settings,
      createdBy: projects.createdBy,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();

  return rows[0] || null;
}
