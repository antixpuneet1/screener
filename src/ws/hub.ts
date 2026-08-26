import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

/** Broadcasts screener updates to every connected dashboard client. */
export class WsHub {
  private wss: WebSocketServer;
  private lastPayload: string | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket: WebSocket) => {
      if (this.lastPayload) socket.send(this.lastPayload);
    });
  }

  broadcast(payload: unknown): void {
    this.lastPayload = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(this.lastPayload);
    }
  }
}
