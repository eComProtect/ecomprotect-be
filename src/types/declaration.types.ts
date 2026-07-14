import type { IO } from "./socket.types";
import type { auth } from "@/lib/auth";

type Session = typeof auth.$Infer.Session;

declare module "express" {
  interface Request {
    session?: Session;
    io?: IO;
  }
}

declare module "socket.io" {
  interface Socket {
    // The store this socket is authenticated as (see connAuthBridge) — the
    // owner's users.id, same key rooms are joined under, regardless of
    // whether the connecting user is the owner or a staff account.
    storeId?: string;
  }
}
