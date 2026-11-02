import * as vscode from "vscode";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Proxy, startProxy } from "./proxy";

// One DeckWerk collab server per library (the folder holding the deck folders).
//
// The server has no authentication, and this node is shared, so it never
// listens where others can reach it: it runs in a private user + network
// namespace (`unshare -rn`), whose 127.0.0.1:5800 exists only in there. A
// bridge inside (bridge.ts) exposes it as a unix socket in a 0700 dir, and
// proxy.ts re-exposes that on loopback to our own uid; VS Code forwards the
// proxy's port to the UI.

const INNER_PORT = 5800;
const READY_TIMEOUT_MS = 120_000;
const IDLE_STOP_MS = 30_000;

/** Per-user state: unix sockets, and which window serves which library. */
const STATE_DIR = path.join(os.tmpdir(), `deckwerk-vscode-${process.getuid!()}`);

interface Owner {
  pid: number;
  port: number;
}

class DeckServer {
  private constructor(
    readonly port: number,
    private readonly child: ChildProcess,
    private readonly proxy: Proxy,
    private readonly runDir: string,
    private readonly ownerFile: string,
  ) {}

  static async start(root: string, extensionDir: string, log: vscode.OutputChannel): Promise<DeckServer> {
    const cfg = vscode.workspace.getConfiguration("deckwerk");
    const checkout = cfg.get<string>("path")?.trim();
    if (!checkout) throw new Error("Set `deckwerk.path` to your DeckWerk checkout.");
    if (!fs.existsSync(path.join(checkout, "dist", "collab", "index.html"))) {
      throw new Error(`No collab client in ${checkout}: run \`npm run build:collab\` there once.`);
    }
    const nodeDir = cfg.get<string>("nodePath")?.trim() ?? "";
    const node = nodeDir ? path.join(nodeDir, "node") : "node";
    const version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
    if (Number(version.slice(1).split(".")[0]) < 22) {
      throw new Error(`DeckWerk needs Node >= 22, \`${node}\` is ${version}: set \`deckwerk.nodePath\`.`);
    }

    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(STATE_DIR, 0o700);
    const runDir = fs.mkdtempSync(path.join(STATE_DIR, "run-"));
    const socketPath = path.join(runDir, "server.sock");

    // Run as uid 0 inside the namespace, where Electron refuses to start sandboxed.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [ffmpegShim(checkout, runDir), nodeDir, process.env.PATH].filter(Boolean).join(":"),
      ELECTRON_DISABLE_SANDBOX: "1",
    };
    // The extension host is itself Electron-as-Node; DeckWerk's Electron helpers must not be.
    for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[key];

    const ip = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip"].find((p) => fs.existsSync(p)) ?? "ip";
    const script =
      `"$1" link set lo up && { "$2" "$3" "$4" ${INNER_PORT} & exec "$2" "$5" ` +
      `--config vitest.config.ts scripts/collab-server.mts "$6" ` +
      `--host 127.0.0.1 --port ${INNER_PORT} --no-local-agents; }`;
    const args = [
      ip,
      node,
      path.join(extensionDir, "out", "bridge.mjs"),
      socketPath,
      path.join(checkout, "node_modules", ".bin", "vite-node"),
      root,
    ];
    log.appendLine(`[deckwerk] starting the server for ${root}`);
    // Its own process group, so stopping it also stops the bridge and Electron helpers.
    const child = spawn("unshare", ["--user", "--map-root-user", "--net", "sh", "-c", script, "sh", ...args], {
      cwd: checkout,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    readline.createInterface({ input: child.stderr! }).on("line", (line) => log.appendLine(line));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DeckWerk server did not start in time")), READY_TIMEOUT_MS);
        readline.createInterface({ input: child.stdout! }).on("line", (line) => {
          log.appendLine(line);
          if (line.startsWith("{") && line.includes('"status":"serving"')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`DeckWerk server exited (code ${code}); see Output › DeckWerk`));
        });
      });
    } catch (err) {
      killGroup(child, "SIGKILL");
      fs.rmSync(runDir, { recursive: true, force: true });
      throw err;
    }

    const proxy = await startProxy(socketPath, (line) => log.appendLine(line));
    const ownerFile = ownerFileOf(root);
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, port: proxy.port } satisfies Owner));
    log.appendLine(`[deckwerk] serving ${root} on 127.0.0.1:${proxy.port} (own uid only)`);
    return new DeckServer(proxy.port, child, proxy, runDir, ownerFile);
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** SIGTERM first: the server saves open decks before it exits. */
  async stop(): Promise<void> {
    this.proxy.close();
    fs.rmSync(this.ownerFile, { force: true });
    if (this.child.exitCode === null) {
      const exited = new Promise((resolve) => this.child.once("exit", resolve));
      killGroup(this.child, "SIGTERM");
      const timer = setTimeout(() => killGroup(this.child, "SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    killGroup(this.child, "SIGKILL"); // whatever of the group outlived the server
    fs.rmSync(this.runDir, { recursive: true, force: true });
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    // group already gone
  }
}

function ownerFileOf(root: string): string {
  const key = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(STATE_DIR, `${key}.json`);
}

/**
 * Started under vite-node, DeckWerk does not find its bundled ffmpeg/ffprobe
 * and falls back to PATH; put them there.
 */
function ffmpegShim(checkout: string, runDir: string): string {
  const bin = path.join(runDir, "bin");
  fs.mkdirSync(bin);
  const arch = process.arch;
  const tools: Record<string, string> = {
    ffmpeg: path.join(checkout, "node_modules", "ffmpeg-static", "ffmpeg"),
    ffprobe: path.join(checkout, "node_modules", "ffprobe-static", "bin", "linux", arch, "ffprobe"),
  };
  for (const [name, target] of Object.entries(tools)) {
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(bin, name));
  }
  return bin;
}

/** The port of a server another VS Code window already runs for this library. */
function runningElsewhere(root: string): number | null {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFileOf(root), "utf8")) as Owner;
    if (owner.pid === process.pid) return null;
    process.kill(owner.pid, 0);
    return owner.port;
  } catch {
    return null;
  }
}

/**
 * The servers this window runs, counted by open tabs. A library is served by
 * one server only — DeckWerk's server must be the single writer of its decks —
 * so a library another window already serves is reused, not started again.
 */
export class ServerPool {
  private servers = new Map<string, Promise<DeckServer>>();
  private users = new Map<string, number>();
  private idle = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly extensionDir: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** The proxy port serving `root`; pair every call with `release(root)`. */
  async acquire(root: string): Promise<number> {
    clearTimeout(this.idle.get(root));
    this.idle.delete(root);
    this.users.set(root, (this.users.get(root) ?? 0) + 1);
    let server = this.servers.get(root);
    // A server that died on its own (see Output › DeckWerk) is started again.
    if (server && !(await server.then((s) => s.alive, () => false))) {
      void server.then((s) => s.stop(), () => undefined);
      this.servers.delete(root);
      server = undefined;
    }
    if (!server) {
      const elsewhere = runningElsewhere(root);
      if (elsewhere !== null) return elsewhere;
      server = DeckServer.start(root, this.extensionDir, this.log);
      this.servers.set(root, server);
      server.catch(() => this.servers.delete(root));
    }
    try {
      return (await server).port;
    } catch (err) {
      this.users.set(root, (this.users.get(root) ?? 1) - 1);
      throw err;
    }
  }

  release(root: string): void {
    const left = (this.users.get(root) ?? 1) - 1;
    this.users.set(root, left);
    if (left > 0 || !this.servers.has(root)) return;
    this.idle.set(root, setTimeout(() => void this.stop(root), IDLE_STOP_MS));
  }

  private async stop(root: string): Promise<void> {
    const server = this.servers.get(root);
    this.servers.delete(root);
    this.idle.delete(root);
    this.log.appendLine(`[deckwerk] stopping the server for ${root}`);
    await (await server?.catch(() => undefined))?.stop();
  }

  async dispose(): Promise<void> {
    for (const timer of this.idle.values()) clearTimeout(timer);
    await Promise.all([...this.servers.keys()].map((root) => this.stop(root)));
  }
}
