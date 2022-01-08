import { Command } from "commander";
import { createServer, IncomingMessage } from "http";
import next from "next";
import { parse } from "url";
import { WebSocket } from "ws";
import { processPending } from "../rs/process/process-pending";
import { Server } from "../rs/server/server";
import { Socket } from "../rs/types/client-state";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const program = new Command().option(
  "-p, --port <port>",
  "port to listen on",
  parseInt
);

process.on("unhandledRejection", (reason, p) => {
  console.log(
    `Unhandled Rejection at: Promise ${p}, reason: ${reason}, stack: ${
      ((reason ?? {}) as any).stack
    }`
  );
});

app.prepare().then(() => {
  program.parse(process.argv);

  const port = program.opts().port || process.env.PORT || 3000;

  const httpServer = createServer((req, res) =>
    handle(req, res, parse(req.url!, true))
  );
  const webSocketServer = new WebSocket.Server({ noServer: true });

  const rs = new Server(new Map(), processPending, performance.now, setTimeout);

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url, true);
    if (pathname === "/rs") {
      webSocketServer.handleUpgrade(req, socket, head, (ws) => {
        rs.handleConnection(ws, req.url!);
      });
    }
  });

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
