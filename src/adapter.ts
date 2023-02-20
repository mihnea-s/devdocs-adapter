import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';

import pako from 'pako';
import tarfs from 'tar-fs';
import fetch from 'node-fetch';
import cssEscape from 'css.escape';
import { LRUMap } from 'lru_map';
import { CheerioAPI, load as cheerio } from 'cheerio';

export type DocSlug = string;

export type DocItem = {
    // Entry information
    doc: DocSlug,
    name: string,
    path: string,

    // Quick Pick item properties
    label: string,
    detail: string,
    description: string,
};

export type DocManifest = {
    name: string,
    slug: DocSlug,
    version: string,
    entries: DocItem[],
};

export class DevDocsAdapter implements vscode.WebviewPanelSerializer {
    private static readonly _webviewType = 'devdocs';

    private readonly _storePath: string;

    private _manifests: Map<DocSlug, DocManifest>;
    private _webviews: Map<DocSlug, vscode.WebviewPanel>;

    constructor(storePath: string) {
        this._webviews = new Map;
        this._manifests = new Map;
        this._storePath = storePath;
    }

    async load(slug: DocSlug, force = false): Promise<void> {
        // Manifest is already loaded
        if (!force && this._manifests.has(slug)) {
            return;
        }

        const indexPath = path.join(this._storePath, slug, 'index.json');

        // Check if documentation exists
        if (!fs.existsSync(indexPath)) {
            return;
        }

        const index = await fs.promises.readFile(indexPath);
        this._manifests.set(slug, JSON.parse(index.toString()));
    }

    async loadAll(slugs: DocSlug[], force = false): Promise<void> {
        this._manifests.clear();
        await Promise.all(slugs.map(doc => this.load(doc, force)));
    }

    private _categorize(entryType: string): string {
        const type = entryType.toLowerCase();

        if (['collection', 'container', 'array'].some(s => type.includes(s))) {
            return '$(symbol-array)';
        }

        return '$(symbol-misc)';
    }

    private async _describe(context: LRUMap<string, CheerioAPI>, slug: DocSlug, itempath: string): Promise<string> {
        const [file, anchor] = itempath.split('#', 2);
        const selector = (!anchor) ? "h1,h2,h3" : `#${cssEscape(anchor)}`;
        const filePath = path.join(this._storePath, slug, file + '.html');

        if (!context.has(filePath)) {
            const htmlText = (await fs.promises.readFile(filePath)).toString();
            context.set(filePath, cheerio(htmlText));
        }

        return context.get(filePath)!(`:is(${selector}) ~ :is(div, p)`).text();
    }

    async download(slug: DocSlug, force = false): Promise<void> {
        const docsetPath = path.join(this._storePath, slug);

        // Docset already on disk
        if (!force && fs.existsSync(docsetPath)) {
            return;
        }

        const resp = await fetch(`https://downloads.devdocs.io/${slug}.tar.gz`);

        if (!resp.ok) {
            vscode.window.showErrorMessage(`Failed to download '${slug}': ${resp.status}`);
            return;
        }

        // Prepare body bytes for extraction
        const gzip = new Uint8Array(await resp.arrayBuffer());

        // File is .tar.gz, ungzip it first
        const tar = pako.ungzip(gzip);

        // Extensions are responsible for creating the storagePath
        await fs.promises.mkdir(this._storePath).catch(() => { });
        await fs.promises.mkdir(docsetPath).catch(() => { });

        // Extract tar to storagePath
        const duplex = new stream.Duplex();
        const extract = tarfs.extract(docsetPath);

        duplex.push(tar);
        duplex.push(null);
        duplex.pipe(extract);

        // Wait until all data is extracted
        await new Promise(res => extract.on('finish', res));

        // Read index and meta
        const [indexFile, metaFile] = await Promise.all([
            fs.promises.readFile(path.join(docsetPath, 'index.json')),
            fs.promises.readFile(path.join(docsetPath, 'meta.json')),
        ] as const);

        const index = JSON.parse(indexFile.toString()) as {
            entries: { name: string, path: string, type: string }[];
        };

        const meta = JSON.parse(metaFile.toString()) as {
            name: string, slug: string, release: string,
        };

        // Used for caching file contents as CheerioAPIs
        const entries = new Array(index.entries.length);
        const describeContext = new LRUMap<string, CheerioAPI>(20);

        for (let i = 0; i < index.entries.length; i++) {
            const entry = index.entries[i];

            entries[i] = {
                doc: meta.slug,
                name: entry.name,
                path: entry.path,
                label: `${this._categorize(entry.type)} ${entry.name}`,
                detail: await this._describe(describeContext, meta.slug, entry.path),
                description: `${meta.name} - ${entry.type}`,
            };
        }

        await fs.promises.writeFile(path.join(docsetPath, 'index.json'), JSON.stringify({
            name: meta.name,
            slug: meta.slug,
            version: meta.release,
            entries,
        }));
    }

    async downloadAll(slugs: DocSlug[], force = false): Promise<void> {
        await vscode.window.withProgress({
            title: 'Downloading documentation',
            location: vscode.ProgressLocation.Notification,
        }, async progress => {
            await Promise.all(slugs.map(async doc => {
                await this.download(doc, force);

                progress.report({
                    message: `installed '${doc}'.`,
                    increment: 100.0 / slugs.length,
                });
            }));
        });
    }

    async items(): Promise<DocItem[]> {
        const items = [] as DocItem[];

        for (const manifest of this._manifests.values()) {
            items.push(...manifest.entries);
        }

        return items;
    }

    private _webview(manifest: DocManifest, panel?: vscode.WebviewPanel): vscode.WebviewPanel {
        const type = DevDocsAdapter._webviewType;
        const title = `${manifest.name} Documentation`;
        const besides = vscode.ViewColumn.Beside;

        panel ??= vscode.window.createWebviewPanel(type, title, besides, {
            localResourceRoots: [vscode.Uri.parse(this._storePath)],
            enableFindWidget: true,
            enableScripts: true,
        });

        panel.title = title;

        panel.onDidDispose(() => {
            this._webviews.delete(manifest.slug);
            panel?.dispose();
        });

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'open') {
                this.open({
                    doc: manifest.slug,
                    path: path.join(path.dirname(message.base), message.href),
                    description: '', detail: '', label: '', name: '',
                });
                return;
            }
        });

        this._webviews.set(manifest.slug, panel);

        return panel;
    }

    private _injected = (window: Window) => {
        const vscode = acquireVsCodeApi<DocItem>();

        // Handle anchor links to external files
        document
            .querySelectorAll<HTMLAnchorElement>('a:not([href^="#"])')
            .forEach(a => a.addEventListener('click', _ => vscode.postMessage({
                command: 'open',
                base: vscode.getState()?.path,
                href: a.getAttribute('href'),
            })));

        window.addEventListener('message', event => {
            const message = event.data;

            if (message.command === 'state') {
                vscode.setState(message.state);
            } else if (message.command === 'anchor') {
                window.document.getElementById(message.anchor)?.scrollIntoView();
            } else if (message.command === 'reset') {
                window.scrollTo({ top: 0 });
            }
        });
    };

    registerWebviewPanelDeserializer(): vscode.Disposable {
        return vscode.window.registerWebviewPanelSerializer(DevDocsAdapter._webviewType, this);
    }

    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: DocItem) {
        const index = this._manifests.get(state.doc)!;
        this._webview(index, panel);
        this.open(state);
    }

    private _postprocess(document: string): string {
        const script = `<script defer>(${this._injected})(window);</script>`;
        const style = `
        <style>
            a {
                text-decoration: none;
            }
            pre { 
                padding: 4px 6px;
                overflow-y: auto;
                background-color: var(--vscode-textBlockQuote-background);
            }
            ._attribution {
                opacity: 50%;
            }
        </style>
        `;
        return style + document + script;
    }

    async open(item: DocItem): Promise<void> {
        const index = this._manifests.get(item.doc)!;
        const panel = this._webviews.get(item.doc) ?? this._webview(index);

        const [file, anchor] = item.path.split('#', 2);
        const filePath = path.join(this._storePath, index.slug, file + '.html');
        const document = (await fs.promises.readFile(filePath)).toString();

        panel.webview.html = this._postprocess(document);

        await panel.webview.postMessage({ command: 'state', state: item });

        if (anchor) {
            await panel.webview.postMessage({ command: 'anchor', anchor });
        } else {
            await panel.webview.postMessage({ command: 'reset' });
        }

        panel.reveal();
    }
}
