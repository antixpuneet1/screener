import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

/** Broadcasts screener updates to every connected dashboard client. */
export class WsHub {
  private wss: WebSocketServer;
  private lastPayload: string | null = null;

  /** Builds the current state for a client that connects before any broadcast has
   *  happened — otherwise a first run with no token configured shows "connecting…"
   *  forever, because nothing is ever pushed to tell it what is wrong. */
  constructor(server: Server, private readonly snapshot?: () => unknown) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    // ws forwards the http server's 'error' events to this WebSocketServer. Without a
    // listener here, EventEmitter rethrows synchronously — which killed the port-stepping
    // retry on EADDRINUSE before our own handler could run.
    this.wss.on("error", (err) => {
      console.error(`[screener] WebSocket server error: ${err.message}`);
    });

    this.wss.on("connection", (socket: WebSocket) => {
      const initial = this.lastPayload ?? (this.snapshot ? JSON.stringify(this.snapshot()) : null);
      if (initial) socket.send(initial);
    });
  }

  broadcast(payload: unknown): void {
    this.lastPayload = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(this.lastPayload);
    }
  }
}
