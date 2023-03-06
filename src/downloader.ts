import * as fs from 'fs';
import * as path from 'path';

import pako from 'pako';
import tar from 'tar-stream';
import fetch from 'node-fetch';
import cssEscape from 'css.escape';

import { workspace, extensions } from 'vscode';

import { LRUMap } from 'lru_map';
import { CheerioAPI, Element, load as cheerio } from 'cheerio';
import { getHighlighter, Highlighter, IShikiTheme, loadTheme } from 'shiki';

export type DocSlug = string;

export type DocItem = {
    // Entry information
    slug: DocSlug,
    name: string,
    path: string,
    anchor?: string,

    // Quick Pick item properties
    label: string,
    detail: string,
    description: string,
};

export type DocMeta = {
    name: string,
    slug: DocSlug,
    version: string,
};

type IndexEntry = {
    name: string,
    path: string,
    type: string,
};

export class Downloader {
    private static readonly extraStyle = `
        <style>
            pre.shiki { 
                padding: 8px 6px;
                overflow-y: auto;
            }
            ._attribution {
                opacity: 50%;
            }
        </style>
    `;

    private static readonly scriptLink = `
        <script async type="module"
            nonce="%%DEVDOCS-VSCODE-ADAPTER-NONCE%%"
            src="%%DEVDOCS-VSCODE-ADAPTER-SCRIPT%%">
        </script>
    `;

    private readonly _storePath: string;

    private _slug: string;
    private _docsetPath: string;
    private _docsetName: string;

    private _highlighter?: Highlighter;
    private _documents = new Map<string, Buffer>();
    private _processedDocuments = new Set<string>();
    private _parsedDocuments = new LRUMap<string, CheerioAPI>(64);

    constructor(storePath: string) {
        this._storePath = storePath;
        this._slug = '';
        this._docsetPath = '';
        this._docsetName = '';
    }

    private async _initHighlighter(): Promise<Highlighter> {
        const currentThemeName = workspace.getConfiguration('workbench').get<string>('colorTheme') ?? 'dark_vs';

        const defaultThemesMap: Record<string, string> = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Default Dark+': 'dark-plus',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Default Light+': 'light-plus',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Visual Studio Dark': 'dark-plus',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Visual Studio Light': 'light-plus',
        };

        const theme = defaultThemesMap[currentThemeName] ?? await (async () => {
            for (const ext of extensions.all) {
                const themes = ext.packageJSON?.contributes?.themes as {
                    label: string, id: string, path: string
                }[];

                if (!themes) {
                    continue;
                }

                const theme = themes.find(theme => {
                    return theme.label === currentThemeName || theme.id === currentThemeName;
                });

                if (theme) {
                    return await loadTheme(path.join(ext.extensionPath, theme.path));
                }
            }

            return 'dark-plus';
        })();

        return await getHighlighter({
            theme,
            paths: {
                wasm: 'out/shiki/onig.wasm',
                themes: 'out/shiki/themes',
                languages: 'out/shiki/languages',
            }
        });
    }

    private _error(msg: string) {
        console.error(msg);
    }

    private _progress(msg: string) {
        console.log(msg);
    }

    private async _fetchExtract(): Promise<void> {
        const resp = await fetch(`https://downloads.devdocs.io/${this._slug}.tar.gz`);

        if (!resp.ok) {
            this._error(`failed to download docset: ${resp.status}`);
            return;
        }

        const inflater = new pako.Inflate();

        let bytesRecv = 0;
        const bytesTotal = resp.headers.get('Content-Length') ?? '???';

        resp.body.on('data', (chunk: Buffer) => {
            inflater.push(chunk);
            bytesRecv += chunk.byteLength;
            this._progress(`downloaded ${bytesRecv}/${bytesTotal}`);
        });

        // Wait for download to finish
        await new Promise(resolve => resp.body.on('end', resolve));

        // Finalize inflate
        inflater.push([], true);

        const extract = tar.extract();

        // Extract each file into the documents map
        extract.on('entry', (headers, stream, next) => {
            const content = [] as Uint8Array[];

            if (headers.type !== 'file') {
                stream.on('end', next);
                stream.resume();
                return;
            }

            stream.on('data', (chunk) => content.push(chunk));

            stream.on('end', () => {
                const fileName = path.normalize(headers.name);
                this._documents.set(fileName, Buffer.concat(content));
                this._progress(`extracted ${fileName}`);
                next();
            });
        });

        extract.on('error', console.error);
        extract.write(inflater.result);
        extract.end();

        // Wait for extraction to finish
        await new Promise(resolve => extract.on('finish', resolve));
    }

    private async _writeFile(fileName: string, content: string): Promise<void> {
        const filePath = path.join(this._docsetPath, fileName);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true }).catch(() => { });
        await fs.promises.writeFile(filePath, content).catch(this._error);
    }

    private async _processDocument(fileName: string): Promise<CheerioAPI | null> {
        const documentHtml = this._documents.get(fileName);

        if (!documentHtml) {
            return null;
        }

        const document = cheerio(documentHtml.toString());

        // Extra JS/CSS
        document('head').append(Downloader.extraStyle);
        document('head').append(Downloader.scriptLink);

        // Fix elements
        document('iframe').remove();

        document('a').each(function () {
            this.tagName = 'vscode-link';
        });

        document('thead, tbody').each(function () {
            const el = document(this);
            const isHeader = this.tagName === 'thead';

            el
                .children()
                .each(function () {
                    const el = document(this);

                    this.tagName = 'vscode-data-grid-row';
                    isHeader && el.attr('row-type', 'header');

                    el.children().each(function () {
                        const el = document(this);

                        this.tagName = 'vscode-data-grid-cell';
                        el.attr('grid-column', (el.index() + 1).toString());
                        el.attr('cell-type', (isHeader ? 'columnheader' : 'default'));
                    });
                })
                .insertAfter(el);

            el.remove();
        });

        document('pre').each((_: number, pre: Element) => {
            const el = document(pre);

            el.html(this._highlighter!.codeToHtml(el.text(), {
                lang: el.attr('data-language'),
            }));
        });

        // Docset specific fixes
        if (this._docsetName === 'javascript') {
            document('section[aria-labelby="try_it"]').remove();
        }

        await this._writeFile(fileName, document.html());
        return document;
    }

    private async _getDocument(fileName: string): Promise<CheerioAPI | null> {
        // Already post-processed, in memory
        if (this._parsedDocuments.has(fileName)) {
            return this._parsedDocuments.get(fileName)!;
        }

        let document: CheerioAPI | null;

        // Already post-processed, written to disk
        if (this._processedDocuments.has(fileName)) {
            document = cheerio((await fs.promises.readFile(fileName)).toString());
        } else {
            document = await this._processDocument(fileName);
        }

        if (document) {
            this._parsedDocuments.set(fileName, document);
        }

        return document;
    }

    private _categorize(entryType: string): string {
        const type = entryType.toLowerCase();

        if (['collection', 'container', 'array'].some(s => type.includes(s))) {
            return '$(symbol-array)';
        }

        return '$(symbol-misc)';
    }

    private async _processEntry(entry: IndexEntry): Promise<DocItem> {
        const [ref, anchor] = entry.path.replace(/\.html$/, '').split('#', 2);
        const path = ref + '.html';

        const document = await this._getDocument(path);

        const name = document
            ? entry.name
            : `~${entry.name}~`;

        const selector = (!anchor) ? 'h1, h2, h3' : `#${cssEscape(anchor)}`;

        const detail = document
            ? document(`:is(${selector}) ~ :is(div, p):not(._attribution)`).text()
            : 'ERROR: Documentation missing for item.';

        const label = `${this._categorize(entry.type)} ${entry.name}`;

        const description = `${this._docsetName} - ${entry.type}`;

        return { slug: this._slug, name, path, anchor, label, detail, description };
    }

    private async _download(slug: DocSlug, force = false): Promise<void> {
        this._highlighter ??= await this._initHighlighter();

        this._documents.clear();
        this._processedDocuments.clear();
        this._parsedDocuments.clear();

        this._slug = slug;
        this._docsetPath = path.join(this._storePath, slug);

        // Docset already on disk
        if (!force && fs.existsSync(this._docsetPath)) {
            return;
        }

        await this._fetchExtract();

        const [indexFile, metaFile] = [
            this._documents.get('index.json'),
            this._documents.get('meta.json'),
        ] as const;

        if (!indexFile || !metaFile) {
            this._error('downloaded documentation does not contain manifests');
            return;
        }

        // Create on disk paths
        const meta = JSON.parse(metaFile.toString());
        await this._writeFile('meta.json', JSON.stringify({
            name: meta.name,
            slug: meta.slug,
            type: meta.type,
        }));

        this._docsetName = meta.name;

        const entries = JSON.parse(indexFile.toString()).entries as IndexEntry[];
        const items = new Array(entries.length);

        for (let i = 0; i < entries.length; i++) {
            items[i] = await this._processEntry(entries[i]);
            console.log(`processed ${entries[i].name} (${i}/${entries.length})`);
        }

        await this._writeFile('items.json', JSON.stringify(items));
    }

    async download(slugs: DocSlug[], force = false): Promise<void> {
        await Promise.all(slugs.map(doc => this._download(doc, force)));

        // await vscode.window.withProgress({
        //     title: 'Downloading documentation',
        //     location: vscode.ProgressLocation.Notification,
        // }, async progress => {
        //     await Promise.all(slugs.map(async doc => {
        //         await this.download(doc, force);

        //         progress.report({
        //             message: `installed '${doc}'.`,
        //             increment: 100.0 / slugs.length,
        //         });
        //     }));
        // });
    }
}
