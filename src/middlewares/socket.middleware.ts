import type { NextFunction, Response, Request } from "express";
import type { Socket, ExtendedError } from "socket.io";
import { logger } from "@/utils/logger.util";
import { IO } from "@/types/socket.types";
import { resolveRequestUser, resolveStoreRow } from "@/middlewares/auth.middleware";

/**
 * This runs on every request.
 */
export const assignSocketToReqIO = (io: IO) => {
  return (req: Request, _: Response, next: NextFunction) => {
    req.io = io;
    next();
  };
};

/**
 * This runs once per socket connection.
 *
 * Uses the same multi-strategy identity resolution as protectRoute (App
 * Bridge session token, raw Shopify access token, API key, then a
 * better-auth cookie session) — not just the cookie session the original
 * version relied on. Embedded merchants (the primary flow) authenticate via
 * an App Bridge bearer token, not a cookie, and third-party cookies are
 * blocked inside the Shopify Admin iframe, so a cookie-only check would fail
 * every embedded socket connection.
 *
 * Joins the room keyed by the store's owner id (via resolveStoreRow), not
 * the connecting user's own id — a staff account's own id is a different
 * value from their store's, and notifications are emitted per-store.
 */
export const connAuthBridge = async (
  socket: Socket,
  next: (error?: ExtendedError) => void
) => {
  const token: string | undefined = socket.handshake.auth?.token;

  const fakeReq = {
    headers: {
      ...socket.request.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  } as unknown as Request;

  const user = await resolveRequestUser(fakeReq);
  const store = user ? await resolveStoreRow(user) : null;

  if (store) {
    socket.storeId = store.id;
    socket.join(store.id);
    logger.info(`Socket handshake successful for store ${store.id}`);
    next();
  } else {
    logger.error("Socket handshake failure: could not resolve an authenticated store");
    next(new Error("Socket handshake failure: unauthenticated"));
  }
};
