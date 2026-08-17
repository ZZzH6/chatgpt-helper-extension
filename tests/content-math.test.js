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
