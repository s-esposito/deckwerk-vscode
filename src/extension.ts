import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { activeDeckUrl, showDeck } from "./panel";
import { ServerPool } from "./server";

let pool: ServerPool | undefined;

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("DeckWerk");
  pool = new ServerPool(context.extensionPath, log);
  const servers = pool;

  // "Open With… › DeckWerk" on a deck.json.
  const deckEditor: vscode.CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose: () => {} }),
    resolveCustomEditor: (document, panel) => showDeck(panel, path.dirname(document.uri.fsPath), servers),
  };

  context.subscriptions.push(
    log,
    vscode.window.registerCustomEditorProvider("deckwerk.deck", deckEditor, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    // Explorer: a deck folder, or its deck.json.
    vscode.commands.registerCommand("deckwerk.open", (uri?: vscode.Uri) => {
      const target = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!target) return;
      const deckDir = path.basename(target) === "deck.json" ? path.dirname(target) : target;
      if (!fs.existsSync(path.join(deckDir, "deck.json"))) {
        void vscode.window.showErrorMessage(`DeckWerk: ${deckDir} is not a deck (no deck.json).`);
        return;
      }
      const panel = vscode.window.createWebviewPanel(
        "deckwerk.panel",
        path.basename(deckDir),
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      void showDeck(panel, deckDir, servers);
    }),
    vscode.commands.registerCommand("deckwerk.openInBrowser", () => {
      const url = activeDeckUrl();
      if (url) void vscode.env.openExternal(url);
    }),
  );
}

export async function deactivate() {
  await pool?.dispose();
}
