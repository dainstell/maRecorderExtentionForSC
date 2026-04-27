async function sendMessage(message) {
  return await chrome.runtime.sendMessage(message);
}

function titleCase(value) {
  return String(value || '')
    .trim()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function suggestTestCaseName(steps, existingCount) {
  const firstClick = (steps || []).find((s) => s.action === 'click');
  const label = firstClick?.readable || '';
  // Try to extract something meaningful from 'Click X ...'
  const m = label.match(/^Click\s+(.+?)(\s+(button|link))?$/i);
  const base = m?.[1] ? titleCase(m[1]) : 'Recorded Flow';
  return `${base} TC ${existingCount + 1}`;
}

function escapeForSingleQuotes(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function csvEscape(value) {
  const s = String(value ?? '');
  const needs = /[",\n\r]/.test(s);
  const escaped = s.replace(/"/g, '""');
  return needs ? `"${escaped}"` : escaped;
}

function stepsToTuskrStepsField(steps) {
  // Tuskr import alternate format:
  // - steps separated by +++
  // - instructions and expected separated by >>>
  return (steps || [])
    .map((s) => {
      const instr = String(s.readable || '').trim();
      const exp = String(s.expected || '').trim();
      if (exp) return `${instr} >>> ${exp}`;
      return instr;
    })
    .filter(Boolean)
    .join(' +++ ');
}

function buildTuskrCsvRow({ name, suite, section, steps }) {
  // Per Tuskr import docs: use a Steps field with +++ and >>> formatting.
  const columns = ['Name', 'Suite', 'Section', 'Type', 'Steps'];

  const record = {
    Name: name || 'Recorded Flow',
    Suite: suite || 'e2e',
    Section: section || 'Chrome Extension Generated',
    Type: 'Usability',
    Steps: stepsToTuskrStepsField(steps)
  };

  return {
    header: columns.join(','),
    row: columns.map((c) => csvEscape(record[c] ?? '')).join(',')
  };
}

function getLocatorExpression(step) {
  const locator = step.locator || {};
  if (locator.type === 'data-cy') return `cy.get('[data-cy="${escapeForSingleQuotes(locator.value)}"]')`;
  if (locator.type === 'id') return `cy.get('#${escapeForSingleQuotes(locator.value)}')`;
  if (locator.type === 'css') return `cy.get('${escapeForSingleQuotes(locator.value)}')`;
  if (locator.type === 'xpath') return `cy.xpath('${escapeForSingleQuotes(locator.value)}')`;
  if (step.cssSelector) return `cy.get('${escapeForSingleQuotes(step.cssSelector)}')`;
  return `cy.get('body')`;
}

function expectedToAssertions(step) {
  const expected = (step.expected || '').trim();
  if (!expected) return [];
  const assertions = [];
  const parts = expected.split(/\.\s+/);

  for (const part of parts) {
    const p = part.trim().replace(/\.+$/, '');
    if (!p) continue;

    const navMatch = p.match(/^Should navigate to (.+)$/i);
    if (navMatch) { assertions.push(`cy.url().should('include', '${escapeForSingleQuotes(navMatch[1].trim())}')`); continue; }

    if (/dialog should appear/i.test(p)) { assertions.push(`cy.get('[role="dialog"]').should('be.visible')`); continue; }
    if (/dialog should close/i.test(p)) { assertions.push(`cy.get('[role="dialog"]').should('not.exist')`); continue; }
    if (/dropdown.*should open|menu should open/i.test(p)) { assertions.push(`cy.get('[role="menu"]').should('be.visible')`); continue; }
    if (/dropdown.*should close|menu should close/i.test(p)) { assertions.push(`cy.get('[role="menu"]').should('not.exist')`); continue; }
    if (/tooltip should appear/i.test(p)) { assertions.push(`cy.get('[role="tooltip"]').should('be.visible')`); continue; }

    const toastMatch = p.match(/message should appear:\s*"(.+)"/i);
    if (toastMatch) { assertions.push(`cy.contains('${escapeForSingleQuotes(toastMatch[1])}').should('be.visible')`); continue; }

    if (/should contain the entered value/i.test(p) && step.value) {
      assertions.push(`${getLocatorExpression(step)}.should('have.value', '${escapeForSingleQuotes(step.value)}')`);
      continue;
    }

    const setToMatch = p.match(/should be set to (.+)$/i);
    if (setToMatch) { assertions.push(`${getLocatorExpression(step)}.should('have.value', '${escapeForSingleQuotes(setToMatch[1])}')`); continue; }

    assertions.push(`// Expected: ${p}`);
  }
  return assertions;
}

function stepToCypress(step) {
  const by = getLocatorExpression(step);

  if (step.action === 'click') return `${by}.click()`;

  if (step.action === 'input') {
    const v = step.value ?? '';
    if (v === '') return `// input: empty value for ${step.readable || ''}`.trim();
    return `${by}.clear().type('${escapeForSingleQuotes(v)}')`;
  }

  if (step.action === 'change') {
    const v = step.value ?? '';
    return `${by}.select('${escapeForSingleQuotes(v)}')`;
  }

  return `// Unsupported: ${step.action}`;
}

function isManual(tc) {
  return (tc.tags || []).includes('manual');
}

function generateCypressBlock(tc) {
  if (isManual(tc)) return null;
  const steps = tc.steps || [];
  const lines = [];
  lines.push(`// Generated by QA Interaction Recorder`);
  lines.push(`// Test case: ${tc.name}`);
  lines.push('');
  lines.push(`describe('${escapeForSingleQuotes(tc.name)}', () => {`);
  lines.push(`  it('runs', () => {`);

  let lastUrl = '';
  for (const s of steps) {
    if (s.pageUrl && s.pageUrl !== lastUrl) {
      lastUrl = s.pageUrl;
      lines.push(`    cy.visit('${escapeForSingleQuotes(lastUrl)}')`);
    }
    lines.push(`    ${stepToCypress(s)}`);
    const assertions = expectedToAssertions(s);
    for (const a of assertions) lines.push(`    ${a}`);
  }

  lines.push('  })');
  lines.push('})');
  return lines.join('\n');
}

function generateCypressMd(cases) {
  const sections = [];
  sections.push('# Test Cases - Cypress');
  sections.push('');

  for (const tc of cases) {
    if (isManual(tc)) continue;
    {
      sections.push(`## ${tc.name}`);
      sections.push('');
      sections.push('```javascript');
      sections.push(generateCypressBlock(tc));
      sections.push('```');
      sections.push('');
    }
  }

  return sections.join('\n');
}

function renderList(steps) {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!steps.length) {
    const empty = document.createElement('div');
    empty.className = 'item';
    empty.innerHTML = '<div class="title">No steps yet</div><div class="meta">Interact with a page (click/type) and come back.</div>';
    list.appendChild(empty);
    return;
  }

  steps.forEach((s, idx) => {
    const item = document.createElement('div');
    item.className = 'item';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `${idx + 1}. ${s.readable || s.action}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.action} | <${s.tagName}> | ${s.locator?.type || ''}: ${s.locator?.value || ''}`;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'QA_REMOVE_STEP', payload: { index: idx } });
      await refresh();
    });

    const expectedBtn = document.createElement('button');
    expectedBtn.textContent = 'Expected';
    expectedBtn.addEventListener('click', async () => {
      const current = s.expected || '';
      const next = window.prompt('Expected result for this step:', current);
      if (next === null) return;
      await sendMessage({ type: 'QA_UPDATE_STEP', payload: { index: idx, patch: { expected: String(next) } } });
      await refresh();
    });

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', async () => {
      const nextReadable = window.prompt('Edit step text:', s.readable || '');
      if (nextReadable === null) return;

      const patch = { readable: String(nextReadable) };
      if (s.action === 'input' || s.action === 'change') {
        const nextValue = window.prompt('Edit value (optional):', s.value ?? '');
        if (nextValue !== null) patch.value = String(nextValue);
      }

      await sendMessage({ type: 'QA_UPDATE_STEP', payload: { index: idx, patch } });
      await refresh();
    });

    actions.appendChild(removeBtn);
    actions.appendChild(expectedBtn);
    actions.appendChild(editBtn);

    item.appendChild(title);
    item.appendChild(meta);

    if (s.expected) {
      const exp = document.createElement('div');
      exp.className = 'meta';
      exp.textContent = `Expected: ${s.expected}`;
      item.appendChild(exp);
    }

    item.appendChild(actions);

    list.appendChild(item);
  });
}

const selectedCases = new Set();
let currentTestcases = [];

function renderHistory(testcases) {
  currentTestcases = testcases;
  const history = document.getElementById('history');

  // Keep the batch bar, clear the rest
  const batchBar = document.getElementById('batchBar');
  history.innerHTML = '';
  history.appendChild(batchBar);

  const headerItem = document.createElement('div');
  headerItem.className = 'item';
  headerItem.innerHTML = '<div class="title">History</div><div class="meta">Saved test cases</div>';
  history.appendChild(headerItem);

  if (!testcases.length) {
    batchBar.style.display = 'none';
    const empty = document.createElement('div');
    empty.className = 'item';
    empty.innerHTML = '<div class="title">No saved test cases</div><div class="meta">Stop a recording and save it.</div>';
    history.appendChild(empty);
    return;
  }

  batchBar.style.display = 'flex';

  // Clean up stale selections
  const ids = new Set(testcases.map((t) => t.id));
  for (const id of selectedCases) { if (!ids.has(id)) selectedCases.delete(id); }
  document.getElementById('selectAll').checked = testcases.length > 0 && testcases.every((t) => selectedCases.has(t.id));

  testcases.forEach((tc) => {
    const item = document.createElement('div');
    item.className = 'item';

    // Checkbox + title row
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'case-check';
    cb.checked = selectedCases.has(tc.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCases.add(tc.id);
      else selectedCases.delete(tc.id);
      document.getElementById('selectAll').checked = testcases.every((t) => selectedCases.has(t.id));
    });

    const title = document.createElement('div');
    title.className = 'title';
    title.style.flex = '1';
    title.textContent = tc.name;

    titleRow.appendChild(cb);
    titleRow.appendChild(title);

    // Tags
    if (tc.tags && tc.tags.length) {
      const tagsSpan = document.createElement('span');
      tagsSpan.style.cssText = 'display:inline-flex;gap:4px;margin-left:4px;';
      tc.tags.forEach((tag) => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip' + (tag === 'manual' ? ' manual' : '');
        chip.textContent = tag;
        tagsSpan.appendChild(chip);
      });
      titleRow.appendChild(tagsSpan);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${(tc.steps || []).length} steps | ${new Date(tc.createdAt).toLocaleString()}`;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    // Edit button — opens edit-case page
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      const url = chrome.runtime.getURL(`edit-case.html?id=${encodeURIComponent(tc.id)}`);
      chrome.tabs.create({ url });
    });

    // Export Cypress
    const exportBtn = document.createElement('button');
    exportBtn.textContent = isManual(tc) ? 'Manual' : 'Cypress';
    exportBtn.disabled = isManual(tc);
    if (!isManual(tc)) {
      exportBtn.addEventListener('click', () => {
        const code = generateCypressBlock(tc);
        if (code) showExport(code);
      });
    }

    // Export CSV with section prompt
    const exportCsvBtn = document.createElement('button');
    exportCsvBtn.textContent = 'CSV';
    exportCsvBtn.addEventListener('click', () => {
      const section = window.prompt('Tuskr Section name:', tc.section || '');
      if (section === null) return;
      const { header, row } = buildTuskrCsvRow({ name: tc.name, suite: 'e2e', section: section.trim(), steps: tc.steps || [] });
      const csv = [header, row].join('\n');
      showExport(csv);
      downloadTextFile(`${sanitizeFilename(tc.name)}.csv`, csv, 'text/csv');
    });

    // Delete
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'QA_DELETE_TESTCASE', payload: { id: tc.id } });
      selectedCases.delete(tc.id);
      await refresh();
    });

    actions.appendChild(editBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(exportCsvBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(titleRow);
    item.appendChild(meta);
    item.appendChild(actions);
    history.appendChild(item);
  });
}

async function updateRecordingButtons() {
  const resp = await sendMessage({ type: 'QA_GET_RECORDING_STATE' });
  const recording = Boolean(resp.recording);
  document.getElementById('start').disabled = recording;
  document.getElementById('stop').disabled = !recording;
}

async function refresh() {
  const exportArea = document.getElementById('exportArea');
  exportArea.classList.add('hidden');
  exportArea.value = '';

  const resp = await sendMessage({ type: 'QA_GET_STEPS' });
  renderList(resp.steps || []);

  const hist = await sendMessage({ type: 'QA_GET_TESTCASES' });
  renderHistory(hist.testcases || []);

  await updateRecordingButtons();
}

function showExport(text) {
  const exportArea = document.getElementById('exportArea');
  exportArea.classList.remove('hidden');
  exportArea.value = text;
  exportArea.focus();
  exportArea.select();
}

function sanitizeFilename(name) {
  return String(name || 'test-case')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 _\-\.]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function downloadTextFile(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('refresh').addEventListener('click', refresh);

document.getElementById('openRecorder').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('recorder.html');
  await chrome.tabs.create({ url });
});

document.getElementById('start').addEventListener('click', async () => {
  await sendMessage({ type: 'QA_START_RECORDING' });
  await refresh();
});

document.getElementById('stop').addEventListener('click', async () => {
  await sendMessage({ type: 'QA_STOP_RECORDING' });
  await refresh();
});

document.getElementById('save').addEventListener('click', async () => {
  // Stop first to finalize
  const stopResp = await sendMessage({ type: 'QA_STOP_RECORDING' });
  const steps = stopResp.steps || [];

  const hist = await sendMessage({ type: 'QA_GET_TESTCASES' });
  const suggested = suggestTestCaseName(steps, (hist.testcases || []).length);
  const name = window.prompt('Test case name:', suggested);
  if (!name) {
    await refresh();
    return;
  }

  await sendMessage({ type: 'QA_SAVE_TESTCASE', payload: { name, steps } });
  await refresh();
});

document.getElementById('clear').addEventListener('click', async () => {
  await sendMessage({ type: 'QA_CLEAR_STEPS' });
  await refresh();
});

document.getElementById('exportJson').addEventListener('click', async () => {
  const resp = await sendMessage({ type: 'QA_GET_STEPS' });
  showExport(JSON.stringify(resp.steps || [], null, 2));
});

document.getElementById('exportCypress').addEventListener('click', async () => {
  const resp = await sendMessage({ type: 'QA_GET_STEPS' });
  const steps = resp.steps || [];
  const lines = [];
  lines.push(`// Generated by QA Interaction Recorder`);
  lines.push(`// Note: xpath requires cypress-xpath plugin if any step uses cy.xpath()`);
  lines.push('');
  lines.push('describe(\'Recorded flow\', () => {');
  lines.push('  it(\'runs\', () => {');

  let lastUrl = '';
  for (const s of steps) {
    if (s.pageUrl && s.pageUrl !== lastUrl) {
      lastUrl = s.pageUrl;
      lines.push(`    cy.visit('${escapeForSingleQuotes(lastUrl)}')`);
    }
    lines.push(`    ${stepToCypress(s)}`);
    const assertions = expectedToAssertions(s);
    for (const a of assertions) lines.push(`    ${a}`);
  }

  lines.push('  })');
  lines.push('})');

  showExport(lines.join('\n'));
});

document.getElementById('exportCsv').addEventListener('click', async () => {
  const resp = await sendMessage({ type: 'QA_GET_STEPS' });
  const steps = resp.steps || [];

  const hist = await sendMessage({ type: 'QA_GET_TESTCASES' });
  const suggestedName = suggestTestCaseName(steps, (hist.testcases || []).length);
  const name = window.prompt('Tuskr Test Case Name:', suggestedName);
  if (name === null) return;

  const section = window.prompt('Tuskr Section name:', '');
  if (section === null) return;

  const { header, row } = buildTuskrCsvRow({ name: String(name).trim() || suggestedName, suite: 'e2e', section: section.trim(), steps });
  const csv = [header, row].join('\n');
  showExport(csv);
  downloadTextFile(`${sanitizeFilename(String(name).trim() || suggestedName)}.csv`, csv, 'text/csv');
});

// --- Select All ---
document.getElementById('selectAll').addEventListener('change', (e) => {
  const checked = e.target.checked;
  currentTestcases.forEach((tc) => {
    if (checked) selectedCases.add(tc.id);
    else selectedCases.delete(tc.id);
  });
  document.querySelectorAll('.case-check').forEach((cb) => { cb.checked = checked; });
});

// --- Batch Tuskr CSV ---
document.getElementById('batchTuskr').addEventListener('click', () => {
  const selected = currentTestcases.filter((tc) => selectedCases.has(tc.id));
  if (!selected.length) { alert('No cases selected.'); return; }

  const section = window.prompt('Tuskr Section name (applies to all selected):', '');
  if (section === null) return;

  const columns = ['Name', 'Suite', 'Section', 'Type', 'Steps'];
  const rows = [columns.join(',')];

  for (const tc of selected) {
    const { row } = buildTuskrCsvRow({ name: tc.name, suite: 'e2e', section: section.trim(), steps: tc.steps || [] });
    rows.push(row);
  }

  const csv = rows.join('\n');
  showExport(csv);
  downloadTextFile('test-cases-tuskr.csv', csv, 'text/csv');
});

// --- Batch Cypress MD ---
document.getElementById('batchCypressMd').addEventListener('click', () => {
  const selected = currentTestcases.filter((tc) => selectedCases.has(tc.id));
  if (!selected.length) { alert('No cases selected.'); return; }

  const md = generateCypressMd(selected);
  showExport(md);
  downloadTextFile('test-cases-cypress.md', md, 'text/markdown');
});

refresh();
