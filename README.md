# DeckWerk for VS Code

Open a [DeckWerk](https://github.com/vsitzmann/deckwerk) slide deck in a VS Code
editor tab: the full DeckWerk editor, present mode included, with every edit
saved straight into the deck folder. Built for VS Code over Remote-SSH: the
extension and DeckWerk's server run on the remote machine, only the UI is local.

## Setup

1. A DeckWerk source checkout with its dependencies and the browser client built:

   ```bash
   cd <deckwerk> && npm ci && npm run build:collab
   ```

2. Settings (on the remote):

   | Setting | Value |
   |---|---|
   | `deckwerk.path` | the DeckWerk checkout |
   | `deckwerk.nodePath` | a folder with Node >= 22's `node`, if `node` on PATH is older |

3. Install: `npm install && npm run package`, then *Extensions › … › Install from
   VSIX…*. For development, open this folder and press F5.

## Use

- Right-click a deck folder (or its `deck.json`) in the Explorer › **Open in DeckWerk**,
  or open a `deck.json` with *Open With… › DeckWerk*.
- **Open in Browser** (editor title bar) opens the same deck in your local browser,
  for true fullscreen presenting and the speaker view, which a webview cannot give.

## How it works

The extension runs DeckWerk's headless collaboration server (`scripts/collab-server.mts`),
one per library (the folder that holds the deck folder), and frames its browser
editor in a webview through VS Code's port forwarding. The server stops 30 s
after its last tab closes, saving open decks first.

The server has no authentication, and a cluster node is shared, so it is never
reachable by other users:

- It runs in a private user + network namespace (`unshare --user --map-root-user --net`),
  so its `127.0.0.1:5800` exists only in there.
- A bridge inside (`src/bridge.ts`) exposes it as a unix socket in a `0700` directory
  under `$TMPDIR/deckwerk-vscode-<uid>/`.
- A proxy in the extension (`src/proxy.ts`) re-exposes that socket on loopback, and admits
  a connection only when the socket on its other end belongs to your uid. VS Code's port
  forwarding runs as you; other users' connections are refused.

Inside the namespace the server runs as uid 0, where Electron refuses its
sandbox, so DeckWerk's offscreen rendering runs with `ELECTRON_DISABLE_SANDBOX=1`.
DeckWerk itself is used as is.

## Caveats

- **The server is the deck's writer.** Don't open the same deck in the desktop app at
  the same time. A second VS Code window reuses the first window's server, which
  stops when that window closes.
- **Edits from other tools** (`slide-agent apply`, git) to `deck.json` / `theme.css`
  are picked up and pushed to the tab. An external write landing within a second of
  an unsaved edit in the tab loses to it; `.versions/` keeps both sides.
- **Network filesystems**: DeckWerk notices external edits through file watching, which
  on Lustre/NFS sees only writes made on the same machine. Don't edit an open deck from
  another node.
- Hosted decks gain `history.jsonl` and `.versions/` (DeckWerk's edit log and
  versions): gitignore them if the deck is in a repository.
- While focus is inside the deck tab, keys go to DeckWerk, not to VS Code
  (Ctrl+P etc.); click outside the tab first.
