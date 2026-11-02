// Runs inside the collab server's private network namespace (see server.ts):
// joins the unix socket the extension connects to with the server's
// 127.0.0.1:<port>, which exists only in that namespace.
//   node bridge.mjs <socket path> <port>
import * as fs from "node:fs";
import * as net from "node:net";

const [socketPath, port] = process.argv.slice(2);

fs.rmSync(socketPath, { force: true });
net
  .createServer((client) => {
    const upstream = net.connect(Number(port), "127.0.0.1");
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  })
  .listen(socketPath);
