import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';

import { Downloader, DocSlug, DocMeta, DocItem } from './downloader';

export class DevDocsAdapter implements vscode.WebviewPanelSerializer {
    private static readonly _webviewType = 'devdocs';

    private readonly _storePath: string;
    private readonly _extensionUri: vscode.Uri;

    private _items: DocItem[];

    private _manifests: Map<DocSlug, DocMeta>;
    private _webviews: Map<DocSlug, vscode.WebviewPanel>;
    private _downloader: Downloader;

    constructor(storePath: string, extensionPath: vscode.Uri) {
        this._storePath = storePath;
        this._extensionUri = extensionPath;
        this._items = [];
        this._webviews = new Map;
        this._manifests = new Map;
        this._downloader = new Downloader(storePath);
    }

    async items(): Promise<DocItem[]> {
        return this._items;
    }

    async load(slugs: DocSlug[], force = false): Promise<void> {
        const prevManifests = this._manifests;

        this._items = [];
        this._manifests = new Map;

        await this._downloader.download(slugs, force);

        for (const slug of slugs) {
            // Manifest is already loaded
            if (!force && prevManifests.has(slug)) {
                this._manifests.set(slug, prevManifests.get(slug)!);
            }

            const [metaPath, itemsPath] = [
                path.join(this._storePath, slug, 'meta.json'),
                path.join(this._storePath, slug, 'items.json'),
            ] as const;

            if (!fs.existsSync(metaPath) || !fs.existsSync(itemsPath)) {
                vscode.window.showErrorMessage(`Missing meta file for '${slug}'`);
                return;
            }

            const [meta, items] = await Promise.all([
                fs.promises.readFile(metaPath),
                fs.promises.readFile(itemsPath),
            ]);

            this._manifests.set(slug, JSON.parse(meta.toString()));
            this._items.push(...JSON.parse(items.toString()));
        }
    }

    async open(item: Pick<DocItem, 'slug' | 'path' | 'anchor'>): Promise<void> {
        const panel = this._webviews.get(item.slug) ?? this._webview(item.slug);

        const filePath = path.join(this._storePath, item.slug, item.path);
        const scriptNonce = "M8LWX42MSEc6nq6x62bIocPNIm8BhuI8";
        const scriptPath = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out', 'webview.js'));

        const htmlSource = (await fs.promises.readFile(filePath)).toString();

        panel.webview.html = htmlSource
            .replace('%%DEVDOCS-VSCODE-ADAPTER-NONCE%%', scriptNonce)
            .replace('%%DEVDOCS-VSCODE-ADAPTER-SCRIPT%%', scriptPath.toString());

        await panel.webview.postMessage({ command: 'state', state: item });

        if (item.anchor) {
            await panel.webview.postMessage({ command: 'anchor', anchor: item.anchor });
        } else {
            await panel.webview.postMessage({ command: 'reset' });
        }

        panel.reveal();
    }

    private _webview(slug: DocSlug, panel?: vscode.WebviewPanel): vscode.WebviewPanel {
        const meta = this._manifests.get(slug)!;

        const type = DevDocsAdapter._webviewType;
        const title = `${meta.name} Documentation`;
        const besides = vscode.ViewColumn.Beside;

        panel ??= vscode.window.createWebviewPanel(type, title, besides, {
            enableScripts: true,
            enableFindWidget: true,
            localResourceRoots: [
                vscode.Uri.parse(this._storePath),
                vscode.Uri.joinPath(this._extensionUri, 'out')
            ],
        });

        panel.title = title;

        panel.onDidDispose(() => {
            this._webviews.delete(meta.slug);
            panel?.dispose();
        });

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'open') {
                const [file, anchor]: [string, string] = message.href.split('#', 2);
                const href = file.replace(/\.html$/, '') + '.html';
                this.open({ slug, anchor, path: path.join(path.dirname(message.base), href) });
                return;
            }
        });

        this._webviews.set(meta.slug, panel);

        return panel;
    }

    registerWebviewPanelDeserializer(): vscode.Disposable {
        return vscode.window.registerWebviewPanelSerializer(DevDocsAdapter._webviewType, this);
    }

    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: DocItem) {
        this._webview(state.slug, panel);
        this.open(state);
    }
}
