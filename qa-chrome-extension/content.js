const DEBOUNCE_MS = 250;
const INPUT_IDLE_MS = 900;
const EXPECTED_DETECT_DELAY = 800;
const TOAST_OBSERVE_WINDOW_MS = 5000;
let lastEventKey = '';
let lastEventAt = 0;

const pendingInputTimers = new Map();
const lastSentInputValue = new Map();

// --- Auto expected result detection via DOM snapshots ---

const UI_SELECTORS = {
  dialog: '[role="dialog"], .modal, .q-dialog, [class*="dialog"]:not(style):not(script), [class*="modal"]:not(style):not(script)',
  alert: '[role="alert"], .toast, .q-notification, .snackbar, [class*="notification"]:not(style):not(script), [class*="toast"]:not(style):not(script)',
  menu: '[role="menu"], [role="listbox"], .q-menu, .dropdown-menu, [class*="dropdown-menu"]',
  tooltip: '[role="tooltip"], .q-tooltip, .tooltip',
  loading: '.q-loading, .spinner, [class*="loading-overlay"]'
};

function countVisible(selector) {
  try {
    return [...document.querySelectorAll(selector)].filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }).length;
  } catch { return 0; }
}

function getNewestElementText(selector, prevCount) {
  try {
    const els = [...document.querySelectorAll(selector)].filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    if (els.length <= prevCount) return '';
    const newest = els[els.length - 1];
    // Try to get title/header from the new element
    const heading = newest.querySelector('h1, h2, h3, h4, .title, .header, [class*="title"]');
    if (heading) {
      const t = cleanVisibleText((heading.innerText || heading.textContent || '').trim()).slice(0, 80);
      if (t) return t;
    }
    const t = cleanVisibleText((newest.innerText || newest.textContent || '').trim()).slice(0, 80);
    return t || '';
  } catch { return ''; }
}

function takeDomSnapshot() {
  return {
    url: location.href,
    title: document.title,
    dialogs: countVisible(UI_SELECTORS.dialog),
    alerts: countVisible(UI_SELECTORS.alert),
    menus: countVisible(UI_SELECTORS.menu),
    tooltips: countVisible(UI_SELECTORS.tooltip)
  };
}

function classifyClickTarget(el) {
  if (!el || el.nodeType !== 1) return 'element';
  const dataCy = (el.getAttribute('data-cy') || '').toLowerCase();
  const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
  const role = (el.getAttribute('role') || '').toLowerCase();
  const tokens = `${dataCy} ${cls} ${role}`;

  if (/date|calendar|datepicker|date-picker/.test(tokens)) return 'date-picker';
  if (/color-picker|colorpicker/.test(tokens)) return 'color-picker';
  if (/time-picker|timepicker/.test(tokens)) return 'time-picker';
  if (/search|autocomplete|typeahead/.test(tokens)) return 'search';
  if (/sort|order/.test(tokens)) return 'sort';
  if (/filter/.test(tokens)) return 'filter';
  if (/sidebar|drawer|sidenav/.test(tokens)) return 'sidebar';
  if (/accordion|expand|collapse/.test(tokens)) return 'accordion';
  if (role === 'tab' || /\btab\b/.test(tokens)) return 'tab';
  if (role === 'combobox' || role === 'listbox' || /select|combo|dropdown/.test(tokens)) return 'dropdown';
  if (/modal|dialog|popup|overlay/.test(tokens)) return 'dialog';
  if (/upload|file/.test(tokens)) return 'file-upload';
  return 'element';
}

const MENU_OPEN_LABELS = {
  'date-picker': 'Date picker should open',
  'color-picker': 'Color picker should open',
  'time-picker': 'Time picker should open',
  'search': 'Search suggestions should appear',
  'sort': 'Sort options should appear',
  'filter': 'Filter options should appear',
  'dropdown': 'Dropdown should open',
  'element': 'Dropdown/menu should open'
};

const MENU_CLOSE_LABELS = {
  'date-picker': 'Date picker should close',
  'color-picker': 'Color picker should close',
  'time-picker': 'Time picker should close',
  'search': 'Search suggestions should close',
  'sort': 'Sort options should close',
  'filter': 'Filter options should close',
  'dropdown': 'Dropdown should close',
  'element': 'Dropdown/menu should close'
};

function detectExpectedFromSnapshots(before, after, targetEl) {
  const results = [];
  const kind = classifyClickTarget(targetEl);

  if (before.url !== after.url) {
    const path = new URL(after.url).pathname;
    results.push(`Should navigate to ${path}`);
  }

  if (after.dialogs > before.dialogs) {
    const text = getNewestElementText(UI_SELECTORS.dialog, before.dialogs);
    results.push(text ? `${text} dialog should appear` : 'Dialog should appear');
  } else if (after.dialogs < before.dialogs) {
    results.push('Dialog should close');
  }

  // Note: alerts/toasts are handled by MutationObserver, skip here

  if (after.menus > before.menus) {
    results.push(MENU_OPEN_LABELS[kind] || MENU_OPEN_LABELS['element']);
  } else if (after.menus < before.menus) {
    results.push(MENU_CLOSE_LABELS[kind] || MENU_CLOSE_LABELS['element']);
  }

  if (after.tooltips > before.tooltips) {
    results.push('Tooltip should appear');
  }

  return results.join('. ');
}

// --- MutationObserver-based toast/notification watcher ---

const TOAST_NODE_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '.toast',
  '.q-notification',
  '.q-notification__message',
  '.snackbar',
  '.Toastify__toast',
  '.q-banner',
  '[class*="notification"]:not(style):not(script)',
  '[class*="toast"]:not(style):not(script)',
  '[class*="snackbar"]:not(style):not(script)',
  '[class*="success-message"]',
  '[class*="error-message"]',
  '[class*="alert-message"]'
];

function isToastNode(el) {
  if (!el || el.nodeType !== 1) return false;
  return TOAST_NODE_SELECTORS.some((sel) => {
    try { return el.matches(sel); } catch { return false; }
  });
}

function findToastInSubtree(el) {
  if (!el || el.nodeType !== 1) return null;
  if (isToastNode(el)) return el;
  for (const sel of TOAST_NODE_SELECTORS) {
    try {
      const found = el.querySelector(sel);
      if (found) return found;
    } catch { /* skip */ }
  }
  return null;
}

function extractToastText(el) {
  if (!el) return '';
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return '';
  return cleanVisibleText((el.innerText || el.textContent || '').trim()).slice(0, 120);
}

/**
 * Generate a context-aware expected result from the element itself.
 * Used as a fallback when snapshot/toast detection finds nothing.
 */
function guessExpectedFromElement(el) {
  if (!el || el.nodeType !== 1) return '';

  const tag = (el.tagName || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const ariaExpanded = el.getAttribute('aria-expanded');
  const ariaChecked = el.getAttribute('aria-checked');
  const label = getLabelForElement(el);
  const kind = classifyClickTarget(el);

  // Specific component types (aligned with snapshot labels)
  if (kind === 'date-picker') return `Date picker should open`;
  if (kind === 'color-picker') return `Color picker should open`;
  if (kind === 'time-picker') return `Time picker should open`;
  if (kind === 'search') return `Search suggestions should appear`;
  if (kind === 'sort') return `Sort options should appear`;
  if (kind === 'filter') return `Filter options should appear`;
  if (kind === 'file-upload') return `File upload dialog should open`;
  if (kind === 'dropdown') return `${label} dropdown should open`;
  if (kind === 'dialog') return `${label} dialog should open`;

  if (kind === 'sidebar') return `Sidebar/drawer should toggle`;

  if (kind === 'accordion' || ariaExpanded !== null) {
    const state = ariaExpanded === 'true' ? 'collapse' : 'expand';
    return `${label} section should ${state}`;
  }

  if (kind === 'tab') return `${label} tab should become active`;

  // Toggle / switch / checkbox
  if (role === 'switch' || type === 'checkbox' || ariaChecked !== null) {
    return `${label} should toggle its state`;
  }

  // Radio
  if (type === 'radio' || role === 'radio') {
    return `${label} option should be selected`;
  }

  // Link
  if (tag === 'a') {
    const href = el.getAttribute('href') || '';
    if (href && href !== '#' && !href.startsWith('javascript')) {
      return `Should navigate to ${href}`;
    }
    return `${label} link action should complete`;
  }

  // Button (generic)
  if (tag === 'button' || role === 'button') {
    return `${label} action should be performed`;
  }

  // Any other interactive element
  return `${label} should respond to interaction`;
}

function createExpectedState(stepIndex, fallbackText) {
  const state = { snapshot: '', toast: '', fallback: fallbackText || '' };
  let fallbackApplied = false;

  function merge() {
    const parts = [state.snapshot, state.toast].filter(Boolean);
    return parts.join('. ');
  }

  // After all async detection windows close, apply fallback if nothing found
  if (fallbackText) {
    setTimeout(() => {
      if (!fallbackApplied && !state.snapshot && !state.toast) {
        fallbackApplied = true;
        patchStepExpected(stepIndex, state.fallback);
      }
    }, 1500);
  }

  return {
    setSnapshot(val) {
      state.snapshot = val || '';
      const merged = merge();
      if (merged) { fallbackApplied = true; patchStepExpected(stepIndex, merged); }
    },
    setToast(val) {
      state.toast = val || '';
      const merged = merge();
      if (merged) { fallbackApplied = true; patchStepExpected(stepIndex, merged); }
    },
    getSnapshot() { return state.snapshot; },
    getToast() { return state.toast; }
  };
}

function watchForToastAndPatch(stepIndex, expectedState) {
  let done = false;
  const seen = new Set();

  const observer = new MutationObserver((mutations) => {
    if (done) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const toast = findToastInSubtree(node);
        if (!toast) continue;

        // Small delay to let text content render
        setTimeout(() => {
          if (done) return;
          const text = extractToastText(toast);
          if (!text || seen.has(text)) return;
          seen.add(text);

          done = true;
          observer.disconnect();

          const toastExpected = `Success/notification message should appear: "${text}"`;
          expectedState.setToast(toastExpected);
        }, 100);
      }
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  setTimeout(() => {
    if (!done) {
      done = true;
      observer.disconnect();
    }
  }, TOAST_OBSERVE_WINDOW_MS);
}

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
    'close',
    'check_circle',
    'check_circle_outline',
    'check',
    'done',
    'done_all',
    'error',
    'error_outline',
    'warning',
    'warning_amber',
    'info',
    'info_outline',
    'cancel',
    'highlight_off',
    'help',
    'help_outline',
    'notifications',
    'notifications_none',
    'notification_important',
    'thumb_up',
    'thumb_down',
    'star',
    'star_border',
    'star_half',
    'delete',
    'delete_outline',
    'edit',
    'add',
    'remove',
    'search',
    'visibility',
    'visibility_off',
    'content_copy',
    'content_paste',
    'refresh',
    'sync',
    'save',
    'settings',
    'menu',
    'home',
    'person',
    'logout',
    'login',
    'lock',
    'lock_open',
    'arrow_back',
    'arrow_forward',
    'chevron_left',
    'chevron_right',
    'first_page',
    'last_page',
    'navigate_before',
    'navigate_next',
    'open_in_new',
    'launch',
    'file_download',
    'file_upload',
    'attach_file',
    'link',
    'schedule',
    'access_time',
    'event',
    'calendar_today',
    'task_alt',
    'verified',
    'new_releases',
    'report',
    'report_problem',
    'block',
    'do_not_disturb',
    'priority_high',
    'flag',
    'bookmark',
    'bookmark_border',
    'favorite',
    'favorite_border'
  ]);

  // Regex: single-word tokens that look like Material Icon ligatures (snake_case with underscores)
  const iconLigaturePattern = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

  const parts = t
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter((p) => {
      const token = p.trim();
      if (!token) return false;
      if (blacklist.has(token)) return false;
      if (iconLigaturePattern.test(token)) return false;
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

const TOP_LEVEL_IDS = new Set(['app', 'root', '__nuxt', '__next', 'q-app', 'main-content', 'wrapper']);

function isTopLevelContainer(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'body' || tag === 'html') return true;
  const id = (el.getAttribute('id') || '').toLowerCase();
  if (TOP_LEVEL_IDS.has(id)) return true;
  // Very large elements covering most of the viewport are likely containers
  const rect = el.getBoundingClientRect();
  if (rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.8) return true;
  return false;
}

function isMeaningfulClickTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  if (isTopLevelContainer(el)) return false;

  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return true;

  const role = String(el.getAttribute('role') || '').toLowerCase();
  if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'option' || role === 'tab') return true;

  if (window.QASelectors.getDataCy(el)) return true;
  if (window.QASelectors.getId(el)) return true;

  if (typeof el.onclick === 'function') return true;
  const tabIndex = el.getAttribute('tabindex');
  if (tabIndex !== null && tabIndex !== '-1') return true;

  // Recognize elements with 'clickable' or 'selectable' CSS class
  const cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
  if (/\b(clickable|selectable|btn|toggle|switch)\b/.test(cls)) return true;

  // Check cursor:pointer as a hint of interactivity
  try {
    const style = window.getComputedStyle(el);
    if (style.cursor === 'pointer') return true;
  } catch { /* skip */ }

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

function isTrivialText(t) {
  if (!t) return true;
  const s = t.trim();
  if (s.length === 0) return true;
  // Pure numbers (possibly with comma/dot/space separators) — e.g. "716", "1,200", "3.5"
  if (/^[\d,.\s]+$/.test(s)) return true;
  // Very short (1–2 chars) non-word tokens — e.g. "×", ">"
  if (s.length <= 2 && !/[a-zA-Z]{2}/.test(s)) return true;
  return false;
}

function findAncestorLabel(el, maxHops) {
  let node = el?.parentElement;
  let hops = 0;
  while (node && node !== document.body && hops < (maxHops || 5)) {
    const dc = (node.getAttribute('data-cy') || '').trim();
    if (dc) {
      const h = humanizeToken(dc);
      if (h) return h;
    }
    const nid = (node.getAttribute('id') || '').trim();
    if (nid) {
      const h = humanizeToken(nid);
      if (h) return h;
    }
    const aria = (node.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    node = node.parentElement;
    hops++;
  }
  return '';
}

function stripTrailingStats(text) {
  if (!text) return text;
  // Remove trailing numeric tokens: "22.6K", "1,200", "5.2K", "100%", "3/10", "$500" etc.
  return text.replace(/[\s]+[\d$€£¥#][\d,.\s]*[KkMmBb%]?(\s*\/\s*\d+)?$/g, '').trim();
}

function getCompactText(el) {
  if (!el || el.nodeType !== 1) return '';
  let fullText = cleanVisibleText(window.QASelectors.getElementText(el));
  fullText = stripTrailingStats(fullText);
  // Short enough — use directly
  if (fullText && fullText.length <= 50) return fullText;

  // Text too long — try to find a shorter, more meaningful child text
  const candidates = el.querySelectorAll('.title, .label, .name, .text, h1, h2, h3, h4, h5, h6, span, strong, b, em');
  for (const child of candidates) {
    const ct = cleanVisibleText((child.innerText || child.textContent || '').trim());
    if (ct && !isTrivialText(ct) && ct.length >= 3 && ct.length <= 60) return ct;
  }

  // Try direct children text nodes
  for (const child of el.children) {
    const ct = cleanVisibleText((child.innerText || child.textContent || '').trim());
    if (ct && !isTrivialText(ct) && ct.length >= 3 && ct.length <= 50) return ct;
  }

  // Truncate full text as last resort
  if (fullText && fullText.length > 50) return fullText.slice(0, 50).trim();
  return fullText || '';
}

function getLabelForElement(el) {
  const text = getCompactText(el);
  const aria = cleanVisibleText((el.getAttribute('aria-label') || '').trim());
  const title = cleanVisibleText((el.getAttribute('title') || '').trim());
  const placeholder = cleanVisibleText((el.getAttribute('placeholder') || '').trim());
  const labelText = cleanVisibleText(getAssociatedLabelText(el));
  const dataCy = window.QASelectors.getDataCy(el);
  const humanDataCy = humanizeToken(dataCy);
  const id = window.QASelectors.getId(el);
  const humanId = humanizeToken(id);
  const nameAttr = (el.getAttribute('name') || '').trim();
  const humanName = humanizeToken(nameAttr);

  // If visible text is meaningful (not just a number/symbol), use it
  if (text && !isTrivialText(text)) return text;

  // Prefer semantic identifiers over trivial text
  if (aria) return aria;
  if (title) return title;
  if (humanDataCy) return humanDataCy;
  if (humanId) return humanId;
  if (placeholder) return placeholder;
  if (labelText) return labelText;
  if (humanName) return humanName;
  if (nameAttr) return nameAttr;

  // Walk up ancestors to find nearest data-cy / id / aria-label
  const ancestorLabel = findAncestorLabel(el);
  if (ancestorLabel) return ancestorLabel;

  // Fall back to trivial text if nothing better found
  if (text) return text;

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
    const resp = await chrome.runtime.sendMessage({ type: 'QA_ADD_STEP', payload: step });
    return resp || {};
  } catch {
    return {};
  }
}

async function patchStepExpected(stepIndex, expected) {
  if (!expected || stepIndex < 0) return;
  try {
    await chrome.runtime.sendMessage({
      type: 'QA_UPDATE_STEP',
      payload: { index: stepIndex, patch: { expected } }
    });
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

  // Snapshot DOM state before the click's side effects render
  const before = takeDomSnapshot();
  const payload = buildStepPayload('click', target, '');
  const fallback = guessExpectedFromElement(target);

  sendStep(payload).then((resp) => {
    if (!resp?.ok || resp.ignored) return;
    const stepIndex = (resp.stepsCount || 1) - 1;
    const es = createExpectedState(stepIndex, fallback);

    // 800ms snapshot for fast UI changes (dialog, menu, URL)
    setTimeout(() => {
      const after = takeDomSnapshot();
      const expected = detectExpectedFromSnapshots(before, after, target);
      if (expected) es.setSnapshot(expected);
    }, EXPECTED_DETECT_DELAY);

    // MutationObserver for async toasts/notifications (up to 5s)
    watchForToastAndPatch(stepIndex, es);
  });
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
      sendStep(payload).then((resp) => {
        if (!resp?.ok || resp.ignored) return;
        const stepIndex = (resp.stepsCount || 1) - 1;
        const es = createExpectedState(stepIndex);
        // Auto expected for input: value should be entered
        const label = getLabelForElement(target);
        if (value) es.setSnapshot(`${label} should contain the entered value`);

        // Watch for async toasts (e.g. auto-save success)
        watchForToastAndPatch(stepIndex, es);
      });
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
  sendStep(payload).then((resp) => {
    if (!resp?.ok || resp.ignored) return;
    const stepIndex = (resp.stepsCount || 1) - 1;
    const es = createExpectedState(stepIndex);
    const label = getLabelForElement(target);
    if (value) es.setSnapshot(`${label} should be set to ${value}`);

    // Watch for async toasts (e.g. toggle/radio save success)
    watchForToastAndPatch(stepIndex, es);
  });
}

document.addEventListener('click', onClick, true);
document.addEventListener('input', onInput, true);
document.addEventListener('change', onChange, true);
