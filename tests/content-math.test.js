const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let linkedom = null;
try {
  linkedom = require('linkedom');
} catch {
  linkedom = null;
}

const contentPath = path.join(__dirname, '..', 'chatgpt-helper-extension', 'content.js');

function loadMathHelpers() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function mathMlToLatex(math) {');
  const end = source.indexOf('  function cleanLatexCandidate(text) {');
  assert.notEqual(start, -1, 'mathMlToLatex should exist in content.js');
  assert.notEqual(end, -1, 'cleanLatexCandidate should exist in content.js');
  assert.ok(end > start, 'math helpers should be located before cleanLatexCandidate');

  const helpers = {};
  const segment = `${source.slice(start, end)}
helpers.mathMlToLatex = mathMlToLatex;
helpers.katexHtmlToLatex = katexHtmlToLatex;`;
  new Function('Node', 'Element', 'helpers', segment)(linkedom.Node, linkedom.Element, helpers);
  return helpers;
}

function loadLatexExtractor() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function extractLatexFromNode(node) {');
  const end = source.lastIndexOf('\n})();');
  assert.notEqual(start, -1, 'extractLatexFromNode should exist in content.js');
  assert.ok(end > start, 'formula extraction helpers should follow extractLatexFromNode');

  const helpers = {};
  const prelude = `
function normalizeWhitespace(text) {
  return String(text || '').replace(/\\s+/g, ' ').trim();
}
`;
  const segment = `${prelude}${source.slice(start, end)}
helpers.extractLatexFromNode = extractLatexFromNode;`;
  new Function('Element', 'Node', 'helpers', segment)(linkedom.Element, linkedom.Node, helpers);
  return helpers;
}

function loadFormulaFinder() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function findFormulaNode(target) {');
  const end = source.lastIndexOf('\n})();');
  assert.notEqual(start, -1, 'findFormulaNode should exist in content.js');
  assert.ok(end > start, 'formula finder helpers should follow findFormulaNode');

  const helpers = {};
  const prelude = `
const FORMULA_SELECTORS = [
  '.katex', '.katex-display', 'mjx-container', 'math', '[data-tex]', '[data-latex]',
  '[data-math]', '[data-mathml]', '[data-math-mode]', '[data-formula]',
  '[data-testid*="math"]', '[role="math"]', '[aria-roledescription="math"]',
  '.math', '.math-inline', '.math-display', '.math-block', '.math-container',
  '.MathJax_Display', '.MathJax',
].join(',');
let settings = { copyMode: 'latex' };
let hoveredFormulaNode = null;
let formulaFeedbackEl = null;
let formulaFeedbackTimer = null;
const navigator = { clipboard: { writeText: async () => {} } };
const window = { innerWidth: 1280, innerHeight: 720, clearTimeout() {}, setTimeout() {} };
function normalizeWhitespace(text) {
  return String(text || '').replace(/\\s+/g, ' ').trim();
}
function normalizeCopyMode(mode) {
  return mode === 'markdown' || mode === 'word' ? mode : 'latex';
}
function ensureFormulaUi() {
  formulaFeedbackEl = {
    hidden: false,
    classList: { add() {}, remove() {} },
    style: {},
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
}
function showToast() {}
`;
  const segment = `${prelude}${source.slice(start, end)}
helpers.findFormulaNode = findFormulaNode;
helpers.handleFormulaClick = handleFormulaClick;
helpers.isVisibleFormulaCandidate = isVisibleFormulaCandidate;`;
  new Function('Element', 'Node', 'helpers', segment)(linkedom.Element, linkedom.Node, helpers);
  return helpers;
}

function loadLatexCopyNormalizer() {
  const source = fs.readFileSync(contentPath, 'utf8');
  const start = source.indexOf('  function normalizeLatexForCopy(latex) {');
  const end = source.lastIndexOf('\n})();');
  assert.notEqual(start, -1, 'normalizeLatexForCopy should exist in content.js');
  assert.ok(end > start, 'copy normalization helpers should follow normalizeLatexForCopy');

  const helpers = {};
  const segment = `${source.slice(start, end)}
helpers.normalizeLatexForCopy = normalizeLatexForCopy;`;
  new Function('helpers', segment)(helpers);
  return helpers;
}

const katexHtmlFixture = `
<span class="katex"><span class="katex-html" aria-hidden="true">
  <span class="base">
    <span class="minner">
      <span class="minner">
        <span class="mopen nulldelimiter"></span>
        <span class="mord">
          <span class="mfrac"><span class="vlist-t vlist-t2"><span class="vlist-r"><span class="vlist" style="height:0.8801em;">
            <span style="top:-2.655em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight"><span class="mord mathnormal mtight">d</span><span class="mord mathnormal mtight">y</span></span></span></span>
            <span style="top:-3.394em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight"><span class="mord mathnormal mtight">d</span></span></span></span>
          </span><span class="vlist-s">​</span></span><span class="vlist-r"><span class="vlist" style="height:0.4811em;"><span></span></span></span></span></span>
        </span>
        <span class="mord mathnormal">f</span>
        <span class="mopen">(</span>
        <span class="mord"><span class="mord mathnormal">x</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.55em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">0</span></span></span></span></span></span></span></span>
        <span class="mpunct">,</span>
        <span class="mord mathnormal">y</span>
        <span class="mclose">)</span>
        <span class="mclose"><span class="delimsizing mult"><svg viewBox="0 0 333 1800"><path d="M145 15 v585 v600 v585 z"></path></svg></span></span>
      </span>
      <span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.55em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight"><span class="mord mathnormal mtight">y</span><span class="mrel mtight">=</span><span class="mord mtight"><span class="mord mathnormal mtight">y</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.55em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">0</span></span></span></span></span></span></span></span></span></span></span></span></span></span></span>
    </span>
    <span class="mrel">=</span>
  </span>
  <span class="base">
    <span class="mord"><span class="mord mathnormal">f</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.55em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mathnormal mtight">y</span></span></span></span></span></span></span></span>
    <span class="mopen">(</span>
    <span class="mord"><span class="mord mathnormal">x</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.55em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">0</span></span></span></span></span></span></span></span>
    <span class="mpunct">,</span>
    <span class="mord"><span class="mord mathnormal">y</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist"><span style="top:-2.55em;"><span class="sizing reset-size6 size3 mtight"><span class="mord mtight">0</span></span></span></span></span></span></span></span>
    <span class="mclose">)</span>
    <span class="mrel">=</span>
  </span>
  <span class="base"><span class="mord">0</span></span>
</span></span>`;

const katexMathmlFixture = `
<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow>
  <msub><mrow>
    <mfrac><mi>d</mi><mrow><mi>d</mi><mi>y</mi></mrow></mfrac>
    <mi>f</mi><mo stretchy="false">(</mo>
    <msub><mi>x</mi><mn>0</mn></msub><mo separator="true">,</mo><mi>y</mi><mo stretchy="false">)</mo>
    <mo fence="true">∣</mo>
  </mrow><mrow>
    <mi>y</mi><mo>=</mo><msub><mi>y</mi><mn>0</mn></msub>
  </mrow></msub>
  <mo>=</mo><msub><mi>f</mi><mi>y</mi></msub>
  <mo stretchy="false">(</mo><msub><mi>x</mi><mn>0</mn></msub><mo separator="true">,</mo><msub><mi>y</mi><mn>0</mn></msub><mo stretchy="false">)</mo>
  <mo>=</mo><mn>0</mn>
</mrow></semantics></math>`;

const expected = '\\left.\\frac{d}{dy}f(x_0,y)\\right|_{y=y_0}=f_y(x_0,y_0)=0';

test('accepts a simple KaTeX HTML-only formula without LaTeX syntax markers', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`
    <div><span class="katex"><span class="katex-html" aria-hidden="true"><span class="base">
      <span class="mord mathnormal">F</span><span class="mopen">(</span>
      <span class="mord mathnormal">a</span><span class="mord mathnormal">x</span>
      <span class="mbin">-</span><span class="mord mathnormal">b</span><span class="mord mathnormal">z</span>
      <span class="mpunct">,</span><span class="mord mathnormal">a</span><span class="mord mathnormal">y</span>
      <span class="mbin">-</span><span class="mord mathnormal">c</span><span class="mord mathnormal">z</span>
      <span class="mclose">)</span><span class="mrel">=</span><span class="mord">0</span>
    </span></span></span></div>`);
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('.katex')), 'F(ax-bz,ay-cz)=0');
});

test('accepts a simple structured MathML formula without LaTeX syntax markers', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`
    <div><math><mrow>
      <mi>F</mi><mo>(</mo><mi>a</mi><mi>x</mi><mo>-</mo><mi>b</mi><mi>z</mi>
      <mo separator="true">,</mo><mi>a</mi><mi>y</mi><mo>-</mo><mi>c</mi><mi>z</mi>
      <mo>)</mo><mo>=</mo><mn>0</mn>
    </mrow></math></div>`);
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('math')), 'F(ax-bz,ay-cz)=0');
});

test('converts KaTeX HTML-only formula back to exact LaTeX', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`<div>${katexHtmlFixture}</div>`);
  const helpers = loadMathHelpers();
  assert.equal(helpers.katexHtmlToLatex(document.querySelector('.katex')), expected);
});

test('converts KaTeX MathML without annotation to exact LaTeX', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`<div>${katexMathmlFixture}</div>`);
  const helpers = loadMathHelpers();
  assert.equal(helpers.mathMlToLatex(document.querySelector('math')), expected);
});

test('extracts LaTeX from a MathML formula through the public extraction path', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`<div>${katexMathmlFixture}</div>`);
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('math')), expected);
});

test('does not copy visible MathJax text as fake LaTeX when source is unavailable', { skip: !linkedom }, () => {
  const visibleText = 'dydf(x0,y)y=y0=fy(x0,y0)=0';
  const { document } = linkedom.parseHTML(
    `<div><mjx-container aria-label="${visibleText}"><svg><text>${visibleText}</text></svg></mjx-container></div>`,
  );
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('mjx-container')), '');
});

test('does not treat a generic data-formula label as LaTeX source', { skip: !linkedom }, () => {
  const visibleText = 'dydf(x0,y)y=y0=fy(x0,y0)=0';
  const { document } = linkedom.parseHTML(
    `<div><span class="math" data-formula="${visibleText}">${visibleText}</span></div>`,
  );
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('[data-formula]')), '');
});

test('does not trust plain data-math display text on rendered formulas', { skip: !linkedom }, () => {
  const visibleText = 'dydf(x0,y)y=y0=fy(x0,y0)=0';
  const { document } = linkedom.parseHTML(
    `<div><span class="math-inline" data-math="${visibleText}">${visibleText}</span></div>`,
  );
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('[data-math]')), '');
});

test('uses exact data-math source from the visual formula ancestor', { skip: !linkedom }, () => {
  const source = "\\boxed{\\text{可导函数在内点取得极值} \\Rightarrow g'(y_0)=0}";
  const { document } = linkedom.parseHTML(`
    <div class="math-block" data-math="${source}">
      <span class="katex-display">
        <span class="katex"><span class="katex-html">可导函数在内点取得极值⇒g′(y0)=0</span></span>
      </span>
    </div>`);
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('.katex-display')), source);
});

test('uses exact data-math source nested inside a formula container', { skip: !linkedom }, () => {
  const source = "\\boxed{\\text{可导函数在内点取得极值} \\Rightarrow g'(y_0)=0}";
  const { document } = linkedom.parseHTML(`
    <div class="math-block">
      <span data-math="${source}"><span class="katex">可导函数在内点取得极值⇒g′(y0)=0</span></span>
    </div>`);
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('.math-block')), source);
});

test('rejects a text-only MathML conversion result', { skip: !linkedom }, () => {
  const visibleText = 'dydf(x0,y)y=y0=fy(x0,y0)=0';
  const { document } = linkedom.parseHTML(
    `<div><math>${visibleText}</math></div>`,
  );
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('math')), '');
});

test('preserves a boxed MathML formula and spacing after an implication arrow', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`
    <div><math><menclose notation="box"><mrow>
      <mtext>可导函数在内点取得极值</mtext>
      <mo>⇒</mo>
      <msup><mi>g</mi><mo>′</mo></msup>
      <mo>(</mo><msub><mi>y</mi><mn>0</mn></msub><mo>)</mo><mo>=</mo><mn>0</mn>
    </mrow></menclose></math></div>`);
  const helpers = loadLatexExtractor();
  const latex = helpers.extractLatexFromNode(document.querySelector('math'));
  assert.equal(latex, '\\boxed{\\text{可导函数在内点取得极值}\\Rightarrowg^\\prime(y_0)=0}');
  const normalizer = loadLatexCopyNormalizer();
  assert.equal(
    normalizer.normalizeLatexForCopy(latex),
    '\\boxed{\\text{可导函数在内点取得极值}\\Rightarrow g^\\prime(y_0)=0}',
  );
});

test('inserts a space between implication commands and following identifiers', { skip: !linkedom }, () => {
  const helpers = loadLatexCopyNormalizer();
  assert.equal(helpers.normalizeLatexForCopy('\\boxed{x}\\Rightarrowg(y_0)=0'), '\\boxed{x}\\Rightarrow g(y_0)=0');
});

test('prefers KaTeX presentation when assistive MathML is incomplete', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`
    <div><span class="katex">
      <span class="katex-mathml"><math>dydf(x0,y)y=y0=fy(x0,y0)=0</math></span>
      <span class="katex-html" aria-hidden="true">
        <span class="base"><span class="mord fbox"><span class="mord">x</span></span></span>
      </span>
    </span></div>`);
  const helpers = loadLatexExtractor();
  assert.equal(helpers.extractLatexFromNode(document.querySelector('.katex')), '\\boxed{x}');
});

test('findFormulaNode returns a visible formula with no currently extractable source', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`
    <div><mjx-container><svg><text>F(ax-bz,ay-cz)=0</text></svg></mjx-container></div>`);
  const formula = document.querySelector('mjx-container');
  formula.getBoundingClientRect = () => ({ width: 120, height: 24 });
  const helpers = loadFormulaFinder();
  assert.equal(helpers.findFormulaNode(formula.querySelector('text')), formula);
});

test('findFormulaNode ignores hidden assistive MathML and returns its visible wrapper', { skip: !linkedom }, () => {
  const { document } = linkedom.parseHTML(`
    <div><span class="katex">
      <span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow></semantics></math></span>
      <span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">x</span></span></span>
    </span></div>`);
  const wrapper = document.querySelector('.katex');
  const math = document.querySelector('math');
  wrapper.getBoundingClientRect = () => ({ width: 18, height: 18 });
  math.getBoundingClientRect = () => ({ width: 0, height: 0 });
  const helpers = loadFormulaFinder();
  assert.equal(helpers.findFormulaNode(math), wrapper);
  assert.equal(helpers.isVisibleFormulaCandidate(math), false);
});

test('does not cancel a click when a visible formula has no copyable source', { skip: !linkedom }, async () => {
  const { document } = linkedom.parseHTML(
    `<div><mjx-container><svg><text>F(ax-bz,ay-cz)=0</text></svg></mjx-container></div>`,
  );
  const formula = document.querySelector('mjx-container');
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefaultCalled: 0,
    stopPropagationCalled: 0,
    preventDefault() { this.preventDefaultCalled += 1; },
    stopPropagation() { this.stopPropagationCalled += 1; },
  };
  const helpers = loadFormulaFinder();
  await helpers.handleFormulaClick(event, formula);
  assert.equal(event.preventDefaultCalled, 0);
  assert.equal(event.stopPropagationCalled, 0);
});

test('cancels and handles a click when a formula has trusted source', { skip: !linkedom }, async () => {
  const { document } = linkedom.parseHTML(
    `<div><span class="katex" data-tex="x^2"><span class="katex-html"><span class="base"><span class="mord">x</span></span></span></span></div>`,
  );
  const formula = document.querySelector('.katex');
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 20,
    clientY: 20,
    preventDefaultCalled: 0,
    stopPropagationCalled: 0,
    preventDefault() { this.preventDefaultCalled += 1; },
    stopPropagation() { this.stopPropagationCalled += 1; },
  };
  const helpers = loadFormulaFinder();
  await helpers.handleFormulaClick(event, formula);
  assert.equal(event.preventDefaultCalled, 1);
  assert.equal(event.stopPropagationCalled, 1);
});
