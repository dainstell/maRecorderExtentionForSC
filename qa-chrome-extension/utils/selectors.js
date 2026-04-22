function cssEscapeIdent(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

function getDataCy(el) {
  if (!el || el.nodeType !== 1) return '';
  const v = el.getAttribute('data-cy');
  return v ? String(v).trim() : '';
}

function getId(el) {
  if (!el || el.nodeType !== 1) return '';
  const v = el.getAttribute('id');
  return v ? String(v).trim() : '';
}

function isUniqueSelector(selector, root = document) {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function buildSimpleCssSelector(el) {
  const tag = el.tagName.toLowerCase();

  const dataCy = getDataCy(el);
  if (dataCy) return `[data-cy="${dataCy.replace(/"/g, '\\"')}"]`;

  const id = getId(el);
  if (id) return `#${cssEscapeIdent(id)}`;

  const nameAttr = el.getAttribute('name');
  if (nameAttr) return `${tag}[name="${nameAttr.replace(/"/g, '\\"')}"]`;

  if (el.classList && el.classList.length) {
    const cls = Array.from(el.classList)
      .filter(Boolean)
      .slice(0, 2)
      .map(cssEscapeIdent)
      .join('.');
    if (cls) return `${tag}.${cls}`;
  }

  return tag;
}

function getUniqueCssSelector(el) {
  if (!el || el.nodeType !== 1) return '';

  const dataCy = getDataCy(el);
  if (dataCy) return `[data-cy="${dataCy.replace(/"/g, '\\"')}"]`;

  const id = getId(el);
  if (id) {
    const sel = `#${cssEscapeIdent(id)}`;
    if (isUniqueSelector(sel)) return sel;
  }

  let current = el;
  const parts = [];

  while (current && current.nodeType === 1 && current !== document.documentElement) {
    let part = buildSimpleCssSelector(current);

    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(part);
    const selector = parts.join(' > ');
    if (isUniqueSelector(selector)) return selector;

    current = current.parentElement;
  }

  const fallback = parts.join(' > ');
  return isUniqueSelector(fallback) ? fallback : '';
}

function getXPath(el) {
  if (!el || el.nodeType !== 1) return '';

  const dataCy = getDataCy(el);
  if (dataCy) return `//*[@data-cy="${dataCy.replace(/"/g, '\\"')}"]`;

  const id = getId(el);
  if (id) return `//*[@id="${id.replace(/"/g, '\\"')}"]`;

  const segments = [];
  let node = el;

  while (node && node.nodeType === 1) {
    const tag = node.tagName.toLowerCase();

    let index = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName.toLowerCase() === tag) index += 1;
      sib = sib.previousElementSibling;
    }

    segments.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }

  return `/${segments.join('/')}`;
}

function getElementText(el) {
  if (!el || el.nodeType !== 1) return '';
  const v = (el.innerText || el.textContent || '').trim();
  return v.replace(/\s+/g, ' ').slice(0, 120);
}

function getBestLocator(el) {
  const dataCy = getDataCy(el);
  if (dataCy) return { type: 'data-cy', value: dataCy, selector: `[data-cy="${dataCy.replace(/"/g, '\\"')}"]` };

  const id = getId(el);
  if (id) {
    const css = `#${cssEscapeIdent(id)}`;
    if (isUniqueSelector(css)) return { type: 'id', value: id, selector: css };
  }

  const css = getUniqueCssSelector(el);
  if (css) return { type: 'css', value: css, selector: css };

  const xpath = getXPath(el);
  return { type: 'xpath', value: xpath, selector: xpath };
}

window.QASelectors = {
  getDataCy,
  getId,
  getUniqueCssSelector,
  getXPath,
  getElementText,
  getBestLocator
};
