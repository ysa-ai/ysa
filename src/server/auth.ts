import type { MiddlewareHandler } from "hono";
import { getOrCreateAuthToken } from "../api/config-store";

export function createAuthMiddleware(getToken: () => string = getOrCreateAuthToken): MiddlewareHandler {
  return async (c, next) => {
    const expected = getToken();
    const authHeader = c.req.header("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== expected) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };
}

export const requireLocalToken = createAuthMiddleware();
