/**
 * User Context
 *
 * The typed slot that `authMiddleware` uses to hand the signed-in user to
 * every loader and action in the authenticated tree. Reading it in a
 * loader or action looks like `const user = context.get(userContext)` --
 * the middleware guarantees it is populated, so route code can assume
 * the user exists without re-querying the database.
 *
 * The `User` shape also defines the role-flag surface that gates access
 * across the app. A plain `isAdmin` is no longer enough at v0.3 -- the
 * admin back-office splits responsibilities across five role flags:
 *
 *   - `isSuperAdmin` unlocks the publish pipeline and promote, and is
 *     the only role that can flip other users' role flags.
 *   - `isCollabAdmin` unlocks project management, team invites, and
 *     the cross-project dashboard without reaching into records or
 *     publishing.
 *   - `isUserManager` unlocks day-to-day user administration --
 *     invites, profile edits, project assignment -- without publish
 *     rights.
 *   - `isCataloguer` marks a user as cataloguing staff so they appear
 *     in project team pickers and see the cataloguing sidebar.
 *   - `isArchiveUser` is a reserved placeholder for a future
 *     read-only research role.
 *
 * Plus `githubId` for users who signed in with GitHub OAuth, so the
 * profile UI can show the link and prevent accidental duplicate accounts.
 *
 * @version v0.3.0
 */

// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { createContext } from "react-router";

export type User = {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
  lastActiveAt: number | null;
  githubId: string | null;
};

export const userContext = createContext<User>();
