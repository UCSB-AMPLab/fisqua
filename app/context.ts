// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { createContext } from "react-router";

export type User = {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
};

/**
 * Typed middleware context for the authenticated user.
 * Set by authMiddleware, consumed by loaders/actions via context.get(userContext).
 */
export const userContext = createContext<User>();
