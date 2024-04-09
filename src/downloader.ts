import * as fs from 'fs';
import * as path from 'path';

import pako from 'pako';
import tar from 'tar-stream';
import fetch from 'node-fetch';
import cssEscape from 'css.escape';
import { LRUMap } from 'lru_map';
import { CheerioAPI, Element, load as cheerio } from 'cheerio';
import { getHighlighter, Highlighter, loadTheme } from 'shiki';
import { extensions, workspace, window, ProgressLocation } from 'vscode';

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
            pre > code {
                background-color: unset;
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
    private _reporter?: (msg: string, incr: number) => void;

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

        const original = require.resolve;

        let overrideResolve: any = (_: string, __: unknown): string => {
            return path.resolve(__dirname, 'shiki/onig.wasm');
        };

        overrideResolve.paths = (_: string): null => {
            return null;
        };

        require.resolve = overrideResolve as RequireResolve;

        const highlighter = await getHighlighter({
            theme,
            paths: {
                themes: 'out/shiki/themes',
                languages: 'out/shiki/languages',
            }
        });

        require.resolve = original;
        return highlighter;
    }

    private _error(msg: string) {
        console.error(msg);
    }

    private _progress(msg: string, incr: number) {
        this._reporter?.(msg, 100 * incr);
    }

    private async _fetchExtract(): Promise<void> {
        const resp = await fetch(`https://downloads.devdocs.io/${this._slug}.tar.gz`);

        if (!resp.ok) {
            this._error(`failed to download docset: ${resp.status}`);
            return;
        }

        const inflater = new pako.Inflate();
        const bytesTotal = +(resp.headers.get('Content-Length') || 10 ** 6);

        resp.body.on('data', (chunk: Buffer) => {
            inflater.push(chunk);
            this._progress('downloading', 0.5 * (chunk.byteLength / bytesTotal));
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

            try {
                el.html(this._highlighter!.codeToHtml(el.text(), {
                    lang: el.attr('data-language'),
                }));
            } catch { }
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

    private async _download(slug: DocSlug): Promise<void> {
        this._highlighter ??= await this._initHighlighter();

        this._documents.clear();
        this._processedDocuments.clear();
        this._parsedDocuments.clear();

        this._slug = slug;
        this._docsetPath = path.join(this._storePath, slug);

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
            this._progress('post-processing', 0.5 / entries.length);
        }

        await this._writeFile('items.json', JSON.stringify(items));
    }

    async download(slugs: DocSlug[], force = false): Promise<void> {
        if (!force) {
            // Docset already on disk
            slugs = slugs.filter(slug => !fs.existsSync(path.join(this._storePath, slug)));
        }

        await Promise.all(slugs.map(doc => window.withProgress(
            {
                title: `Documentation for '${doc}'`,
                location: ProgressLocation.Notification,
            },
            progress => {
                this._reporter = (message, increment) => progress.report({ message, increment });
                return this._download(doc);
            },
        )));
    }
}
