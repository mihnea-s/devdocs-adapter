import {
    provideVSCodeDesignSystem,
    vsCodeLink,
    vsCodeDivider,
    vsCodeDataGrid,
    vsCodeDataGridRow,
    vsCodeDataGridCell,
} from '@vscode/webview-ui-toolkit';

import type { DocItem } from './downloader';

const vscode = acquireVsCodeApi<DocItem>();

provideVSCodeDesignSystem().register(
    vsCodeLink(),
    vsCodeDivider(),
    vsCodeDataGrid(),
    vsCodeDataGridRow(),
    vsCodeDataGridCell(),
);

// Handle anchor links to external files
document
    .querySelectorAll<HTMLAnchorElement>('vscode-link:not([href^="#"])')
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
