import type { IO } from "@/types/socket.types";

/**
 * Emits a freshly-created notification to every socket connected as this
 * store (see connAuthBridge — sockets join a room keyed by the store's
 * owner id). `io` is optional since it comes from `req.io`, only ever unset
 * if assignSocketToReqIO wasn't wired for some call path.
 */
export const emitNewNotification = (
  io: IO | undefined,
  storeId: string,
  notification: unknown
): void => {
  io?.to(storeId).emit("new_notification", notification);
};
