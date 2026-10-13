export type EditorHtmlInput = { cspSource: string; nonce: string; scriptUri: string; styleUri: string; chainEditUri: string };

const attr = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Scripts load only by nonce or from the extension's own files (the editor imports dist/chain-edit.js); nothing inline, nothing remote.
export function editorHtml({ cspSource, nonce, scriptUri, styleUri, chainEditUri }: EditorHtmlInput): string {
  const csp = [`default-src 'none'`, `style-src ${cspSource}`, `img-src ${cspSource}`, `script-src 'nonce-${nonce}' ${cspSource}`].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${attr(styleUri)}">
<title>Coordiner chains</title>
</head>
<body data-chain-edit="${attr(chainEditUri)}">
<div id="banner"></div>
<div class="layout">
<nav id="rail" aria-label="Chains"></nav>
<main id="detail"></main>
</div>
<section id="chat" aria-labelledby="chat-h"></section>
<div id="status" role="status" class="visually-hidden"></div>
<script type="module" nonce="${attr(nonce)}" src="${attr(scriptUri)}"></script>
</body>
</html>
`;
}
