const DEBOUNCE_MS = 250;
const INPUT_IDLE_MS = 900;
let lastEventKey = '';
let lastEventAt = 0;

const pendingInputTimers = new Map();
const lastSentInputValue = new Map();

function cleanVisibleText(text) {
  const t = String(text || '').trim();
  if (!t) return '';

  // Common UI icon glyph names that appear in innerText (e.g., Material Icons)
  const blacklist = new Set([
    'keyboard_arrow_down',
    'keyboard_arrow_up',
    'keyboard_arrow_left',
    'keyboard_arrow_right',
    'expand_more',
    'expand_less',
    'arrow_drop_down',
    'arrow_drop_up',
    'unfold_more',
    'unfold_less',
    'more_vert',
    'more_horiz',
    'close'
  ]);

  const parts = t
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter((p) => {
      const token = p.trim();
      if (!token) return false;
      if (blacklist.has(token)) return false;
      return true;
    });

  return parts.join(' ').trim();
}

function humanizeToken(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  const cleaned = t
    .replace(/[_\-]+/g, ' ')
    .replace(/\b(btn|button)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.replace(/\b\w/g, (m) => m.toUpperCase());
}

function getAssociatedLabelText(el) {
  if (!el || el.nodeType !== 1) return '';

  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${CSS?.escape ? CSS.escape(id) : id}"]`);
    const txt = (label?.innerText || label?.textContent || '').trim();
    if (txt) return txt.replace(/\s+/g, ' ').slice(0, 120);
  }

  const wrappingLabel = el.closest('label');
  const wrapTxt = (wrappingLabel?.innerText || wrappingLabel?.textContent || '').trim();
  if (wrapTxt) return wrapTxt.replace(/\s+/g, ' ').slice(0, 120);

  return '';
}

function isFormControl(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function findInComposedPath(e, predicate) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const n of path) {
    if (n && n.nodeType === 1 && predicate(n)) return n;
  }
  return null;
}

function getInputTargetFromEvent(e) {
  if (isFormControl(e.target)) return e.target;
  const inPath = findInComposedPath(e, isFormControl);
  if (inPath) return inPath;
  const closest = e.target?.closest?.('input, textarea, select');
  return closest || e.target;
}

function isMeaningfulClickTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return true;

  const role = String(el.getAttribute('role') || '').toLowerCase();
  if (role === 'button' || role === 'link') return true;

  if (window.QASelectors.getDataCy(el)) return true;
  if (window.QASelectors.getId(el)) return true;

  if (typeof el.onclick === 'function') return true;
  const tabIndex = el.getAttribute('tabindex');
  if (tabIndex !== null && tabIndex !== '-1') return true;

  return false;
}

function getClickTargetFromEvent(e) {
  // Prefer the closest meaningful clickable element instead of inner icons (<i>, <svg>, etc.)
  let el = e.target;
  let hops = 0;
  while (el && el.nodeType === 1 && hops < 6) {
    if (isMeaningfulClickTarget(el)) return el;
    el = el.parentElement;
    hops += 1;
  }

  const inPath = findInComposedPath(e, isMeaningfulClickTarget);
  return inPath || e.target;
}

function getLabelForElement(el) {
  const text = cleanVisibleText(window.QASelectors.getElementText(el));
  if (text) return text;

  const aria = cleanVisibleText((el.getAttribute('aria-label') || '').trim());
  if (aria) return aria;

  const placeholder = cleanVisibleText((el.getAttribute('placeholder') || '').trim());
  if (placeholder) return placeholder;

  const labelText = cleanVisibleText(getAssociatedLabelText(el));
  if (labelText) return labelText;

  const dataCy = window.QASelectors.getDataCy(el);
  const humanDataCy = humanizeToken(dataCy);
  if (humanDataCy) return humanDataCy;

  const id = window.QASelectors.getId(el);
  const humanId = humanizeToken(id);
  if (humanId) return humanId;

  const nameAttr = (el.getAttribute('name') || '').trim();
  const humanName = humanizeToken(nameAttr);
  if (humanName) return humanName;
  if (nameAttr) return nameAttr;

  return el.tagName.toLowerCase();
}

function normalizeTag(tag) {
  const t = String(tag || '').toLowerCase();
  if (t === 'a') return 'link';
  if (t === 'button') return 'button';
  if (t === 'input') return 'input';
  if (t === 'select') return 'select';
  if (t === 'textarea') return 'textarea';
  return t || 'element';
}

function buildReadableStep(action, el, value) {
  const tag = normalizeTag(el?.tagName);
  const label = getLabelForElement(el);
  const labelLower = String(label || '').toLowerCase();

  if (action === 'click') {
    if (tag === 'button') {
      if (!label || labelLower === 'button') return 'Click button';
      if (labelLower.includes('button')) return `Click ${label}`;
      return `Click ${label} button`;
    }
    if (tag === 'link') {
      if (!label || labelLower === 'link') return 'Click link';
      if (labelLower.includes('link')) return `Click ${label}`;
      return `Click ${label} link`;
    }
    return `Click ${label}`;
  }

  if (action === 'input') {
    if (tag === 'textarea') {
      if (value) return `Type ${value} into ${label} textarea`;
      return `Type into ${label} textarea`;
    }
    if (tag === 'select') return `Select ${value} from ${label}`;
    if (value) return `Type ${value} into ${label} input`;
    return `Type into ${label} input`;
  }

  if (action === 'change') {
    if (tag === 'select') return `Select ${value} from ${label}`;
    return `Change ${label} to ${value}`;
  }

  return `${action} ${label}`;
}

function getEventValue(action, target) {
  if (!target) return '';

  const tag = String(target.tagName || '').toLowerCase();
  const type = String(target.getAttribute('type') || '').toLowerCase();

  const autocomplete = String(target.getAttribute('autocomplete') || '').toLowerCase();

  if (tag === 'input' && (type === 'password' || autocomplete.includes('password'))) {
    return '';
  }

  if (action === 'input' || action === 'change') {
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return String(target.value ?? '').slice(0, 200);
    }
  }

  return '';
}

function shouldDebounce(eventKey) {
  const now = Date.now();
  if (eventKey === lastEventKey && now - lastEventAt < DEBOUNCE_MS) return true;
  lastEventKey = eventKey;
  lastEventAt = now;
  return false;
}

async function sendStep(step) {
  try {
    await chrome.runtime.sendMessage({ type: 'QA_ADD_STEP', payload: step });
  } catch {
    // ignore
  }
}

function buildStepPayload(action, target, value) {
  const locator = window.QASelectors.getBestLocator(target);
  const innerText = window.QASelectors.getElementText(target);

  const tagName = target?.tagName ? target.tagName.toLowerCase() : '';
  const dataCy = window.QASelectors.getDataCy(target);
  const id = window.QASelectors.getId(target);
  const cssSelector = window.QASelectors.getUniqueCssSelector(target) || locator.selector;
  const xpath = window.QASelectors.getXPath(target);

  const readable = buildReadableStep(action, target, value);

  return {
    action,
    readable,
    tagName,
    innerText,
    dataCy,
    id,
    cssSelector,
    xpath,
    locator,
    value,
    pageUrl: location.href
  };
}

function getTargetFromEvent(e, action) {
  if (action === 'input' || action === 'change') return getInputTargetFromEvent(e);
  if (action === 'click') return getClickTargetFromEvent(e);
  return e.target;
}

function onClick(e) {
  const target = getTargetFromEvent(e, 'click');
  if (!target || target.nodeType !== 1) return;

  const locator = window.QASelectors.getBestLocator(target);
  const eventKey = `click|${locator.type}|${locator.value}`;
  if (shouldDebounce(eventKey)) return;

  const payload = buildStepPayload('click', target, '');
  sendStep(payload);
}

function onInput(e) {
  const target = getTargetFromEvent(e, 'input');
  if (!target || target.nodeType !== 1) return;

  const value = getEventValue('input', target);
  const locator = window.QASelectors.getBestLocator(target);
  const key = `input|${locator.type}|${locator.value}`;

  // Wait until the user stops typing to avoid one step per keystroke.
  if (pendingInputTimers.has(key)) {
    clearTimeout(pendingInputTimers.get(key));
  }

  pendingInputTimers.set(
    key,
    setTimeout(() => {
      pendingInputTimers.delete(key);

      const lastSent = lastSentInputValue.get(key) ?? null;
      if (lastSent === value) return;

      lastSentInputValue.set(key, value);
      const payload = buildStepPayload('input', target, value);
      sendStep(payload);
    }, INPUT_IDLE_MS)
  );
}

function onChange(e) {
  const target = getTargetFromEvent(e, 'change');
  if (!target || target.nodeType !== 1) return;

  const value = getEventValue('change', target);
  const locator = window.QASelectors.getBestLocator(target);
  const eventKey = `change|${locator.type}|${locator.value}|${value}`;
  if (shouldDebounce(eventKey)) return;

  const payload = buildStepPayload('change', target, value);
  sendStep(payload);
}

document.addEventListener('click', onClick, true);
document.addEventListener('input', onInput, true);
document.addEventListener('change', onChange, true);
