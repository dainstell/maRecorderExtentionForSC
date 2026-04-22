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

function stepToCypress(step) {
  const locator = step.locator || {};

  let by = '';
  if (locator.type === 'data-cy') by = `cy.get('[data-cy="${escapeForSingleQuotes(locator.value)}"]')`;
  else if (locator.type === 'id') by = `cy.get('#${escapeForSingleQuotes(locator.value)}')`;
  else if (locator.type === 'css') by = `cy.get('${escapeForSingleQuotes(locator.value)}')`;
  else if (locator.type === 'xpath') by = `cy.xpath('${escapeForSingleQuotes(locator.value)}')`;
  else if (step.cssSelector) by = `cy.get('${escapeForSingleQuotes(step.cssSelector)}')`;
  else by = `cy.get('body')`;

  if (step.action === 'click') {
    return `${by}.click()`;
  }

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

function renderHistory(testcases) {
  const history = document.getElementById('history');
  history.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'item';
  header.innerHTML = '<div class="title">History</div><div class="meta">Saved test cases</div>';
  history.appendChild(header);

  if (!testcases.length) {
    const empty = document.createElement('div');
    empty.className = 'item';
    empty.innerHTML = '<div class="title">No saved test cases</div><div class="meta">Stop a recording and save it.</div>';
    history.appendChild(empty);
    return;
  }

  testcases.slice(0, 10).forEach((tc) => {
    const item = document.createElement('div');
    item.className = 'item';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = tc.name;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${(tc.steps || []).length} steps | ${new Date(tc.createdAt).toLocaleString()}`;

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export Cypress';
    exportBtn.addEventListener('click', () => {
      const steps = tc.steps || [];
      const lines = [];
      lines.push(`// Generated by QA Interaction Recorder`);
      lines.push(`// Test case: ${tc.name}`);
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
      }

      lines.push('  })');
      lines.push('})');
      showExport(lines.join('\n'));
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'QA_DELETE_TESTCASE', payload: { id: tc.id } });
      await refresh();
    });

    actions.appendChild(exportBtn);
    const exportCsvBtn = document.createElement('button');
    exportCsvBtn.textContent = 'Export CSV';
    exportCsvBtn.addEventListener('click', () => {
      const { header, row } = buildTuskrCsvRow({ name: tc.name, suite: 'e2e', section: '', steps: tc.steps || [] });
      const csv = [header, row].join('\n');
      showExport(csv);
      downloadTextFile(`${sanitizeFilename(tc.name)}.csv`, csv, 'text/csv');
    });
    actions.appendChild(exportCsvBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(title);
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

  const { header, row } = buildTuskrCsvRow({ name: String(name).trim() || suggestedName, suite: 'e2e', section: '', steps });
  const csv = [header, row].join('\n');
  showExport(csv);
  downloadTextFile(`${sanitizeFilename(String(name).trim() || suggestedName)}.csv`, csv, 'text/csv');
});

refresh();
