/**
 * Scripts — one export at a time, held by the operating system
 *
 * This module deals with keeping one export at a time against each target,
 * by a lock the operating system holds. An export holds its target's lock
 * by listening on a TCP port of the loopback interface,
 * `127.0.0.1:<port>`, from before its first read to its end: `LOCK_PORTS`
 * gives 47391 for production and 47392 for staging. A second run against
 * the same target cannot bind that port: the bind fails with EADDRINUSE,
 * and the run refuses before it reads anything, saying that another export
 * against that target is running or that another program holds the port.
 *
 * Why this is complete. The only thing trusted is the kernel's
 * exclusive bind of one address and port: two listeners cannot hold it
 * at once (the server is opened with `exclusive: true` and without
 * SO_REUSEPORT, so not even Node's cluster sharing applies), and the
 * kernel releases it when the socket closes or the process exits, in
 * whatever way it exits, a crash or a kill -9 included. Nothing is
 * written to disk, so there is no stale state to find, judge or clear,
 * and no window between checking a lock and taking it: the bind is both.
 * A run that is suspended keeps its socket and so keeps the lock; a run
 * that has died has none.
 *
 * The run does not read D1 itself: each statement is sent by a wrangler
 * process it starts (`./d1.ts`). So that a killed run cannot free the
 * port while such a process may still be sending or running a query,
 * every one of them is given the listening socket too, as its file
 * descriptor 3 (`stdio: ["pipe", "pipe", "pipe", fd]`). The kernel keeps
 * a socket bound until every process holding a descriptor to it has
 * closed it or exited, so the port stays bound until the run and the
 * wrangler process it started have both ended, whichever ends last. The
 * process given the descriptor is wrangler's `wrangler-dist/cli.js`, run
 * by node directly: the package's bin (`bin/wrangler.js`) only spawns
 * `cli.js` as a further child, passing on stdin, stdout, stderr and an
 * IPC channel but not descriptor 3, and npx adds yet another layer, so
 * neither is used. `cli.js` makes the D1 request itself. On this path it
 * starts no child that reaches D1: the children it can start are `ps -p`
 * calls, run synchronously, for its agent detection, and `sw_vers` when
 * an error is reported. Node does not pass descriptor 3 on to them, and
 * they exit on their own.
 *
 * On production the process given the descriptor is the production read
 * lock's helper (`../d1-production-lock-run.mjs`, through `./d1.ts`),
 * which runs cli.js with the read lock's own socket as cli.js's
 * descriptor 3 and does not exit before cli.js has ended. So the export's
 * port stays bound until the run and that helper have both ended, and the
 * read lock's port, 47393, until the helper and cli.js have. If the
 * helper alone is killed with SIGKILL mid-statement, the export's port can
 * be freed while cli.js still runs; cli.js still holds 47393, so a second
 * export's first statement waits for it.
 *
 * The port is an argument, so the tests bind ports of their own and
 * never meet a real export's lock. The server serves nothing: any
 * connection that arrives is closed at once.
 *
 * @version v0.9.0
 */

import { createServer } from "node:net";
import { ExportRefusal } from "./checkpoint";

export const LOCK_HOST = "127.0.0.1";
export const LOCK_PORTS = { production: 47391, staging: 47392 } as const;

export interface PortLock {
  /** The listening socket's descriptor, handed to each wrangler process. */
  fd: number;
  /** Closes this process's handle; the port is free once no other process holds it. */
  release: () => Promise<void>;
}

/** Binds the target's port, or refuses. */
export async function acquirePortLock(target: string, port: number): Promise<PortLock> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new ExportRefusal(
            `Another export against ${target} is running, or another program holds ${LOCK_HOST}:${port}; ` +
              `nothing was read. Wait for that export to end, or find what holds the port (lsof -i :${port}).`,
          ),
        );
      } else {
        reject(new ExportRefusal(`Could not bind the export lock ${LOCK_HOST}:${port}: ${err.message}`));
      }
    });
    server.listen({ host: LOCK_HOST, port, exclusive: true }, () => resolve());
  });
  const release = () => new Promise<void>((resolve) => server.close(() => resolve()));
  // Node does not document the descriptor; its handle carries it on Unix.
  const fd = (server as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd <= 2) {
    await release();
    throw new ExportRefusal(`The export lock ${LOCK_HOST}:${port} has no descriptor to hand to wrangler; nothing was read`);
  }
  return { fd, release };
}

// @version v0.9.0
