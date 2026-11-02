import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { ServerPool } from "./server";

// A deck in an editor tab: the webview frames DeckWerk's own browser editor,
// served by the library's collab server (server.ts) through VS Code's port
// forwarding. Every edit is the server's, saved straight into the deck folder.

/** The browser URL of each open deck tab, for "Open in Browser". */
const deckUrls = new Map<vscode.WebviewPanel, vscode.Uri>();

export async function showDeck(panel: vscode.WebviewPanel, deckDir: string, pool: ServerPool): Promise<void> {
  const root = path.dirname(deckDir);
  const deckId = path.basename(deckDir);
  panel.webview.options = { enableScripts: true };
  panel.webview.html = message(`Starting DeckWerk for ${deckId}…`);

  let acquired = false;
  panel.onDidDispose(() => {
    deckUrls.delete(panel);
    if (acquired) pool.release(root);
  });
  try {
    const port = await pool.acquire(root);
    acquired = true;
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port}/`));
    const url = external.with({
      query: `deck=${encodeURIComponent(deckId)}&name=${encodeURIComponent(os.userInfo().username)}`,
    });
    deckUrls.set(panel, url);
    panel.webview.html = frame(url);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    panel.webview.html = message(text);
    void vscode.window.showErrorMessage(`DeckWerk: ${text}`);
  }
}

export function activeDeckUrl(): vscode.Uri | undefined {
  for (const [panel, url] of deckUrls) if (panel.active) return url;
  return undefined;
}

function frame(url: vscode.Uri): string {
  const src = url.toString(true);
  const origin = `${url.scheme}://${url.authority}`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';" />
  <style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body>
  <iframe src="${escapeHtml(src)}" allow="clipboard-read; clipboard-write; autoplay; fullscreen"></iframe>
</body>
</html>`;
}

function message(text: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <style>body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2em; }</style>
</head>
<body><p>${escapeHtml(text)}</p></body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
