import * as vscode from 'vscode';

import { DevDocsAdapter, DocSlug, DocItem } from './adapter';

import docs from './data/docs.json';

const EXT_ID = 'devdocs-adapter';

export async function activate(context: vscode.ExtensionContext) {
    const adapter = new DevDocsAdapter(context.globalStorageUri.fsPath);

    // Initial loading
    await (async () => {
        const config = vscode.workspace.getConfiguration(EXT_ID);
        const docsets = config.get<DocSlug[]>('docsets');
        await adapter.loadAll(docsets ?? []);
    })();

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (!event.affectsConfiguration(`${EXT_ID}.docsets`)) {
            return;
        }

        const config = vscode.workspace.getConfiguration(EXT_ID);
        const docsets = config.get<DocSlug[]>('docsets');

        if (docsets) {
            await adapter.downloadAll(docsets);
            await adapter.loadAll(docsets);
            await vscode.window.showInformationMessage('Documentation reloaded!');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand(`${EXT_ID}.search`, async () => {
        const editor = vscode.window.activeTextEditor;
        const config = vscode.workspace.getConfiguration(EXT_ID);
        const searchCursorHighlight = config.get<boolean>('searchCursorHighlight');

        let highlight = '';

        if (searchCursorHighlight && editor) {
            let cursorPosition = editor.selection.start;
            let wordRange = editor.document.getWordRangeAtPosition(cursorPosition);
            if (wordRange) {
                highlight = editor.document.getText(wordRange) ?? highlight;
            }
        }

        const items = await adapter.items();

        const item = await new Promise<DocItem | undefined>(done => {
            const quickpick = vscode.window.createQuickPick<DocItem>();

            quickpick.items = items;
            quickpick.value = highlight;

            quickpick.matchOnDescription = true;
            quickpick.placeholder = 'Search documentation..';

            quickpick.onDidHide(() => quickpick.dispose());
            quickpick.onDidAccept(() => {
                done(quickpick.selectedItems[0]);
                quickpick.hide();
            });

            quickpick.show();
        });

        if (item) {
            await adapter.open(item);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand(`${EXT_ID}.docsets.manage`, async () => {
        const config = vscode.workspace.getConfiguration(EXT_ID);
        const selected = config.get<DocSlug[]>('docsets') ?? [];

        const items = docs.map(doc => ({
            label: doc.name,
            docset: doc.slug,
            description: doc.release,
            picked: selected.includes(doc.slug),
        }));

        const choices = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select docsets..',
        });

        if (choices) {
            const docsets = choices.map(c => c.docset);
            await config.update('docsets', docsets);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand(`${EXT_ID}.docsets.update`, async () => {
        const config = vscode.workspace.getConfiguration(EXT_ID);
        const docsets = config.get<DocSlug[]>('docsets');

        if (!docsets) {
            return;
        }

        await adapter.downloadAll(docsets, true);
        await adapter.loadAll(docsets, true);

        await vscode.window.showInformationMessage('Documentation updated!');
    }));
}

export function deactivate() { }
