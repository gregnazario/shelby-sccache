import type { Context, Next } from "hono";

export function s3AuthMiddleware(accessKey: string, secretKey: string, validateSignatures: boolean) {
  return async (c: Context, next: Next) => {
    if (!validateSignatures) {
      return next();
    }
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.includes(accessKey)) {
      return c.text("Forbidden", 403);
    }
    return next();
  };
}
