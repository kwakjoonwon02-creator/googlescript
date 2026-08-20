/**
 * Minimal stand-in for HtmlService templating, enough to render index.html
 * exactly the way a deployed web app would.
 *
 * Apps Script scriptlets:
 *   <?  code  ?>   run it
 *   <?=  expr ?>   print it, HTML-escaped
 *   <?!= expr ?>   print it verbatim
 *
 * The escaping difference is the whole point of this file: `<?= ?>` inside a
 * <script> block silently corrupts string literals, and that is invisible to
 * every test that loads the client any other way.
 */
const vm = require('vm');

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * @param {string} template raw template text
 * @param {object} vars values assigned to the template before evaluate()
 * @param {function(string): string} include resolves include('name')
 */
function render(template, vars, include) {
  const parts = [];
  const re = /<\?(=|!=)?([\s\S]*?)\?>/g;
  let last = 0;
  let match;

  while ((match = re.exec(template)) !== null) {
    parts.push({ type: 'text', value: template.slice(last, match.index) });
    last = match.index + match[0].length;
    const kind = match[1];
    const body = match[2].trim().replace(/;$/, '');
    if (kind === '=') parts.push({ type: 'escaped', value: body });
    else if (kind === '!=') parts.push({ type: 'raw', value: body });
    else parts.push({ type: 'code', value: match[2] });
  }
  parts.push({ type: 'text', value: template.slice(last) });

  const out = [];
  const sandbox = Object.assign({ include, htmlEscape }, vars);
  sandbox.__out = out;
  vm.createContext(sandbox);

  parts.forEach(part => {
    if (part.type === 'text') { out.push(part.value); return; }
    if (part.type === 'code') { vm.runInContext(part.value, sandbox); return; }
    const value = vm.runInContext('(' + part.value + ')', sandbox);
    out.push(part.type === 'escaped' ? htmlEscape(value) : String(value));
  });

  return out.join('');
}

module.exports = { render, htmlEscape };
