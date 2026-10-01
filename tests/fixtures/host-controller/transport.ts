/** Local Unix fixture IPC only. This module is never imported by operational entrypoints. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  createHostBridgeCoordinator,
  type HostBridgeCoordinator,
  type HostBridgeHandlers,
} from "../../../scripts/host-bridge-adapter.js";
import type { HostBridgeOperation } from "../../../scripts/host-bridge-frames.js";

const failure = "host-controller-fixture-failed";
const randomName = () => `${randomBytes(16).toString("hex")}.sock`;
function requireValue(value: unknown): asserts value {
  if (!value) throw new Error(failure);
}
function ownedDirectory(root: string): void {
  const info = lstatSync(root);
  requireValue(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid?.() &&
      (info.mode & 0o777) === 0o700,
  );
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, 0o600);
  const info = lstatSync(path);
  requireValue(info.isSocket() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600);
}
export interface FixtureIPC {
  readonly bootstrap: string;
  readonly coordinator: HostBridgeCoordinator;
  readonly allocations: () => number;
  readonly completed: () => number;
  /** Parent child-death teardown never creates a new coordinator. */
  stop(): Promise<void>;
}
export async function startFixtureIPC(
  root: string,
  handlers: HostBridgeHandlers,
  operation_timeout_ms = 10_000,
): Promise<FixtureIPC> {
  ownedDirectory(root);
  const coordinator = createHostBridgeCoordinator(handlers, { operation_timeout_ms });
  const fence = coordinator.fence.bind(coordinator);
  const allocate = coordinator.allocate.bind(coordinator);
  const remaining = coordinator.remaining.bind(coordinator);
  const serve = coordinator.serve.bind(coordinator);
  const session = randomBytes(16).toString("hex");
  const capability = randomBytes(32);
  const controlName = randomName();
  const servers = new Set<Server>();
  const sockets = new Set<Socket>();
  const paths = new Set<string>();
  let allocations = 0;
  let completed = 0;
  let stopped = false;
  const attach = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  };
  const control = createServer({ allowHalfOpen: true }, (socket) => {
    attach(socket);
    let received = Buffer.alloc(0);
    let handling = false;
    const timer = setTimeout(() => {
      fence();
      socket.destroy();
    }, 3000);
    socket.on("data", (bytes: Buffer) => {
      if (handling || received.length + bytes.length > 516) {
        fence();
        socket.destroy();
        return;
      }
      received = Buffer.concat([received, bytes]);
    });
    socket.once("end", () => {
      handling = true;
      void (async () => {
        requireValue(
          !stopped && received.length > 4 && received.readUInt32BE(0) === received.length - 4,
        );
        const raw = received.subarray(4).toString("utf8");
        const value: unknown = JSON.parse(raw);
        requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
        const request = value as Record<string, unknown>;
        requireValue(
          Object.keys(request).join(",") === "schema,session_id,capability,operation" &&
            JSON.stringify(request) === raw,
        );
        requireValue(
          request.schema === 1 &&
            typeof request.session_id === "string" &&
            /^[a-f0-9]{32}$/u.test(request.session_id) &&
            typeof request.capability === "string" &&
            /^[a-f0-9]{64}$/u.test(request.capability),
        );
        requireValue(
          timingSafeEqual(Buffer.from(request.session_id, "hex"), Buffer.from(session, "hex")) &&
            timingSafeEqual(Buffer.from(request.capability, "hex"), capability),
        );
        let response: object;
        if (request.operation === "fence") {
          fence();
          response = { fenced: true };
        } else {
          requireValue(
            request.operation === "exec" ||
              request.operation === "put" ||
              request.operation === "fetch",
          );
          const operation: HostBridgeOperation = request.operation;
          const allocation = allocate(operation);
          allocations++;
          const basename = randomName();
          const path = join(root, basename);
          let accepted = false;
          const server = createServer({ allowHalfOpen: true }, (channel) => {
            attach(channel);
            if (accepted || stopped) {
              fence();
              channel.destroy();
              return;
            }
            accepted = true;
            server.close();
            const input = Readable.toWeb(channel) as unknown as ReadableStream<Uint8Array>;
            const output = Writable.toWeb(channel) as WritableStream<Uint8Array>;
            void serve(allocation, { input, output }).then(
              () => {
                completed++;
              },
              () => {
                channel.destroy();
              },
            );
          });
          server.on("error", () => fence());
          servers.add(server);
          paths.add(path);
          await listen(server, path);
          response = {
            schema: 1,
            session_id: session,
            operation,
            nonce: allocation.nonce,
            socket: basename,
            remaining_ms: remaining(allocation),
          };
        }
        const bytes = Buffer.from(JSON.stringify(response));
        requireValue(bytes.length <= 512);
        const wire = Buffer.alloc(4 + bytes.length);
        wire.writeUInt32BE(bytes.length);
        bytes.copy(wire, 4);
        clearTimeout(timer);
        socket.end(wire);
      })().catch(() => {
        clearTimeout(timer);
        fence();
        socket.destroy();
      });
    });
    socket.once("close", () => clearTimeout(timer));
  });
  control.on("error", () => fence());
  servers.add(control);
  const controlPath = join(root, controlName);
  paths.add(controlPath);
  await listen(control, controlPath);
  const bootstrap = join(root, "bootstrap.json");
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      session_id: session,
      capability: capability.toString("hex"),
      control: controlName,
      local_root: root,
    }),
  );
  requireValue(bytes.length <= 512);
  writeFileSync(bootstrap, bytes, { mode: 0o600, flag: "wx" });
  requireValue(readFileSync(bootstrap).equals(bytes));
  return Object.freeze({
    bootstrap,
    coordinator,
    allocations: () => allocations,
    completed: () => completed,
    async stop() {
      if (stopped) return;
      stopped = true;
      fence();
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [...servers].map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) return resolve();
              server.close(() => resolve());
            }),
        ),
      );
      for (const path of paths) {
        try {
          unlinkSync(path);
        } catch {
          /* Owned sockets may already be removed by close. */
        }
      }
    },
  });
}
