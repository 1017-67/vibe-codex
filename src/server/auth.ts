import { NextFunction, Request, Response } from "express";
import { Config } from "../config/types.js";

export function bearerAuth(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.disableAuth) return next();
    const header = req.header("authorization");
    if (!header) return res.status(401).json({ error: { code: "AUTH_REQUIRED", message: "Authorization bearer token is required.", details: {} } });
    const expected = `Bearer ${config.relayToken}`;
    if (header !== expected) return res.status(403).json({ error: { code: "AUTH_INVALID", message: "Authorization bearer token is invalid.", details: {} } });
    return next();
  };
}
