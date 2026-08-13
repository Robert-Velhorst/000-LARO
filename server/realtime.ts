import type { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";

import { COOKIE_NAME } from "../shared/const";
import { ENV } from "./_core/env";
import { getUser } from "./db";
import { isTokenRevoked } from "./sessionRevocation";

type RealtimeNotification = {
  title: string;
  message?: string;
};

export type RealtimeDataChange = {
  scope: "case" | "evidence" | "outreach" | "message";
  caseId?: string;
};

let realtimeServer: Server | null = null;

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function initializeRealtimeServer(
  httpServer: HttpServer,
  path = "/socket.io"
): Server {
  if (realtimeServer) return realtimeServer;

  const io = new Server(httpServer, {
    path,
    serveClient: false,
  });

  io.use(async (socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, COOKIE_NAME);
    if (!token) return next(new Error("UNAUTHORIZED"));

    try {
      const decoded = jwt.verify(token, ENV.JWT_SECRET) as { userId: string; iat?: number };
      if (await isTokenRevoked(decoded.userId, decoded.iat)) {
        return next(new Error("UNAUTHORIZED"));
      }
      const user = await getUser(decoded.userId);
      if (!user) return next(new Error("UNAUTHORIZED"));
      socket.data.userId = decoded.userId;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    void socket.join(userRoom(userId));
  });

  realtimeServer = io;
  return io;
}

export function emitRealtimeNotification(
  userId: string,
  notification: RealtimeNotification
): void {
  realtimeServer?.to(userRoom(userId)).emit("notification", notification);
}

export function emitRealtimeDataChange(userId: string, change: RealtimeDataChange): void {
  realtimeServer?.to(userRoom(userId)).emit("data_change", change);
}

export function closeRealtimeServer(): Promise<void> {
  const server = realtimeServer;
  realtimeServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
