import * as fs from "node:fs";
import * as net from "node:net";

// Re-exposes the server's unix socket on loopback, where VS Code's port
// forwarding can reach it. Loopback is shared by every user on the node, so
// each connection is admitted only if its other end is a socket of our own uid
// (the owner column of /proc/net/tcp{,6}) — VS Code's forwarder runs as us.
// Listens on 127.0.0.1 AND ::1: `localhost` resolves to ::1 first here.

export interface Proxy {
  port: number;
  close(): void;
}

const LOOPBACK_HEX: Record<string, string> = {
  IPv4: "0100007F",
  IPv6: "00000000000000000000000001000000",
};

function peerUid(socket: net.Socket): number | null {
  // No /proc off Linux; there the server is single-user, so any loopback peer is admitted.
  if (process.platform !== "linux") return process.getuid!();
  const family = socket.remoteFamily === "IPv6" ? "IPv6" : "IPv4";
  const table = family === "IPv6" ? "/proc/net/tcp6" : "/proc/net/tcp";
  const hex = (port: number | undefined) => (port ?? 0).toString(16).toUpperCase().padStart(4, "0");
  // The peer's socket is the row whose local end is its port and whose remote end is ours.
  const local = `${LOOPBACK_HEX[family]}:${hex(socket.remotePort)}`;
  const remote = `${LOOPBACK_HEX[family]}:${hex(socket.localPort)}`;
  for (const line of fs.readFileSync(table, "utf8").split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === local && f[2] === remote) return Number(f[7]);
  }
  return null;
}

export function startProxy(socketPath: string, log: (line: string) => void): Promise<Proxy> {
  const uid = process.getuid!();
  const handle = (client: net.Socket) => {
    const owner = peerUid(client);
    if (owner !== uid) {
      log(`[proxy] refused a connection from uid ${owner}`);
      client.destroy();
      return;
    }
    const upstream = net.connect(socketPath);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  };

  const v4 = net.createServer(handle);
  const v6 = net.createServer(handle);
  return new Promise((resolve, reject) => {
    v4.once("error", reject);
    v4.listen(0, "127.0.0.1", () => {
      const port = (v4.address() as net.AddressInfo).port;
      const done = () => resolve({ port, close: () => { v4.close(); v6.close(); } });
      v6.once("error", (err) => {
        log(`[proxy] no ::1 listener (${err.message}); IPv4 only`);
        done();
      });
      v6.listen({ port, host: "::1", ipv6Only: true }, done);
    });
  });
}
