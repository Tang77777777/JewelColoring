/* This adapter is embedded by package-html.mjs, not loaded by the Cocos project. */
(async () => {
    'use strict';
    const payloadElement = document.getElementById('jewel-bundle');
    let archive = await JSZip.loadAsync(payloadElement.textContent, { base64: true });
    payloadElement.remove();
    const bundle = JSON.parse(await archive.file('bundle.json').async('string'));
    if (bundle.version !== 2) throw new Error('Unsupported standalone bundle version');
    const contents = await Promise.all(bundle.contents.map(async ({ mime, entry }) => ({
        mime, bytes: await archive.file(entry).async('uint8array'), blobURL: null,
    })));
    archive = null;
    const base = new URL('.', location.href);
    const entries = new Map(Object.entries(bundle.assets).map(([name, id]) => [
        new URL(name, base).href, { name, content: contents[id] },
    ]));
    const loaded = new Set();
    const missing = new Set();
    window.__jewelStandalone = {
        engine: bundle.engine, buildHash: bundle.buildHash, assetCount: entries.size,
        uniqueAssetCount: contents.length,
        diagnostics: () => ({ loaded: [...loaded], missing: [...missing] }),
    };

    // Keep logical asset URLs for Cocos/SystemJS; only native I/O receives Blob URLs.
    function embeddedURL(value) {
        const text = String(value);
        if (!text || /^(data|blob):/i.test(text)) return text;
        const url = new URL(text, base);
        url.search = '';
        url.hash = '';
        const entry = entries.get(url.href);
        if (!entry) {
            missing.add(text);
            throw new Error(`Standalone asset is missing: ${text}`);
        }
        const content = entry.content;
        if (!content.blobURL) {
            content.blobURL = URL.createObjectURL(new Blob([content.bytes], { type: content.mime }));
            content.bytes = null;
        }
        loaded.add(entry.name);
        return content.blobURL;
    }

    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
        return open.call(this, method, embeddedURL(url), ...args);
    };
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
        const url = embeddedURL(input instanceof Request ? input.url : input);
        return fetch(input instanceof Request ? new Request(url, input) : url, options);
    };
    for (const type of [HTMLScriptElement, HTMLImageElement, HTMLMediaElement, HTMLSourceElement]) {
        const descriptor = Object.getOwnPropertyDescriptor(type.prototype, 'src');
        Object.defineProperty(type.prototype, 'src', {
            ...descriptor,
            set(value) { descriptor.set.call(this, embeddedURL(value)); },
        });
    }

    function loadScript(name) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.onload = () => { script.remove(); resolve(); };
            script.onerror = () => { script.remove(); reject(new Error(`Unable to load ${name}`)); };
            script.src = name;
            document.head.appendChild(script);
        });
    }
    const importMap = document.createElement('script');
    importMap.type = 'systemjs-importmap';
    importMap.textContent = JSON.stringify(bundle.importMap);
    document.head.appendChild(importMap);
    addEventListener('pagehide', event => {
        if (!event.persisted) {
            for (const content of contents) {
                if (content.blobURL) URL.revokeObjectURL(content.blobURL);
            }
        }
    });

    if (document.readyState === 'loading') {
        await new Promise(resolve => addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
    await loadScript(bundle.polyfills);
    await loadScript(bundle.system);
    await System.import('./' + bundle.entry);
})().catch(error => {
    console.error('[Jewel standalone]', error);
    const message = document.createElement('p');
    message.textContent = 'Unable to load the game. Please reopen this file.';
    message.style.cssText = 'position:fixed;inset:40% 16px auto;color:white;font:16px sans-serif';
    document.body.appendChild(message);
});
