const urlParams = new URLSearchParams(window.location.search);
const caseId = urlParams.get('id');

let currentCase = null;

async function sendMessage(message) {
  return await chrome.runtime.sendMessage(message);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Load & Render ---

async function loadCase() {
  if (!caseId) {
    document.querySelector('.container').innerHTML = '<div class="empty">No test case ID provided.</div>';
    return;
  }

  const resp = await sendMessage({ type: 'QA_GET_TESTCASES' });
  const cases = resp.testcases || [];
  currentCase = cases.find((tc) => tc.id === caseId);

  if (!currentCase) {
    document.querySelector('.container').innerHTML = '<div class="empty">Test case not found.</div>';
    return;
  }

  if (!currentCase.tags) currentCase.tags = [];

  document.getElementById('pageTitle').textContent = `Edit: ${currentCase.name}`;
  document.getElementById('caseName').value = currentCase.name || '';
  renderTags();
  renderSteps();
}

function renderTags() {
  const container = document.getElementById('tagsContainer');
  container.innerHTML = '';
  const tags = currentCase.tags || [];

  tags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip' + (tag === 'manual' ? ' manual' : '');
    chip.innerHTML = `${escapeHtml(tag)} <button data-index="${i}" title="Remove tag">&times;</button>`;
    container.appendChild(chip);
  });

  container.querySelectorAll('button[data-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      currentCase.tags.splice(idx, 1);
      renderTags();
    });
  });
}

function renderSteps() {
  const list = document.getElementById('stepsList');
  list.innerHTML = '';
  const steps = currentCase.steps || [];
  document.getElementById('stepCount').textContent = steps.length;

  if (!steps.length) {
    list.innerHTML = '<div class="empty">No steps in this test case.</div>';
    return;
  }

  steps.forEach((step, idx) => {
    const card = document.createElement('div');
    card.className = 'step-card';

    const hasValue = step.action === 'input' || step.action === 'change';
    const valueField = hasValue
      ? `<div class="step-field">
           <label>Value</label>
           <input type="text" class="step-value" data-index="${idx}" value="${escapeHtml(step.value || '')}" />
         </div>`
      : '';

    card.innerHTML = `
      <div class="step-header">
        <span class="step-num">#${idx + 1}</span>
        <button class="danger step-remove" data-index="${idx}">Remove</button>
      </div>
      <div class="step-field">
        <label>Step Description</label>
        <input type="text" class="step-readable" data-index="${idx}" value="${escapeHtml(step.readable || '')}" />
      </div>
      ${valueField}
      <div class="step-field">
        <label>Expected Result</label>
        <textarea class="step-expected" data-index="${idx}" rows="2">${escapeHtml(step.expected || '')}</textarea>
      </div>
      <div class="step-meta">
        ${escapeHtml(step.action)} | &lt;${escapeHtml(step.tagName || '')}&gt; | ${escapeHtml(step.locator?.type || '')}: ${escapeHtml(step.locator?.value || '')}
      </div>
    `;

    list.appendChild(card);
  });

  // Bind listeners
  list.querySelectorAll('.step-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      currentCase.steps.splice(idx, 1);
      renderSteps();
    });
  });

  list.querySelectorAll('.step-readable').forEach((input) => {
    input.addEventListener('input', () => {
      currentCase.steps[parseInt(input.dataset.index)].readable = input.value;
    });
  });

  list.querySelectorAll('.step-value').forEach((input) => {
    input.addEventListener('input', () => {
      currentCase.steps[parseInt(input.dataset.index)].value = input.value;
    });
  });

  list.querySelectorAll('.step-expected').forEach((textarea) => {
    textarea.addEventListener('input', () => {
      currentCase.steps[parseInt(textarea.dataset.index)].expected = textarea.value;
    });
  });
}

// --- Save ---

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg || 'Changes saved!';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

async function saveCase() {
  if (!currentCase) return;

  const name = document.getElementById('caseName').value.trim();
  if (!name) {
    alert('Please enter a test case name.');
    return;
  }

  currentCase.name = name;

  await sendMessage({
    type: 'QA_UPDATE_TESTCASE',
    payload: {
      id: caseId,
      patch: {
        name: currentCase.name,
        tags: currentCase.tags || [],
        steps: currentCase.steps || []
      }
    }
  });

  document.getElementById('pageTitle').textContent = `Edit: ${currentCase.name}`;
  showToast('Changes saved!');
}

// --- Events ---

document.getElementById('save').addEventListener('click', saveCase);

document.getElementById('back').addEventListener('click', () => {
  window.close();
});

document.getElementById('addTag').addEventListener('click', () => {
  const input = document.getElementById('tagInput');
  const tag = input.value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!tag) return;
  if (!currentCase.tags) currentCase.tags = [];
  if (!currentCase.tags.includes(tag)) {
    currentCase.tags.push(tag);
    renderTags();
  }
  input.value = '';
  input.focus();
});

document.getElementById('tagInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('addTag').click();
  }
});

// Ctrl+S / Cmd+S shortcut to save
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCase();
  }
});

loadCase();
