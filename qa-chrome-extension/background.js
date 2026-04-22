const STORAGE_KEY = 'qaRecorderSteps';
const RECORDING_KEY = 'qaRecorderRecording';
const TESTCASES_KEY = 'qaRecorderTestcases';

async function getSteps() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function setSteps(steps) {
  await chrome.storage.local.set({ [STORAGE_KEY]: steps });
}

async function isRecording() {
  const result = await chrome.storage.local.get([RECORDING_KEY]);
  return Boolean(result[RECORDING_KEY]);
}

async function setRecording(value) {
  await chrome.storage.local.set({ [RECORDING_KEY]: Boolean(value) });
}

async function getTestcases() {
  const result = await chrome.storage.local.get([TESTCASES_KEY]);
  return Array.isArray(result[TESTCASES_KEY]) ? result[TESTCASES_KEY] : [];
}

async function setTestcases(items) {
  await chrome.storage.local.set({ [TESTCASES_KEY]: items });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) return;

    if (message.type === 'QA_ADD_STEP') {
      const recording = await isRecording();
      if (!recording) {
        sendResponse({ ok: true, ignored: true });
        return;
      }
      const steps = await getSteps();
      steps.push({
        ...message.payload,
        ts: Date.now(),
        url: sender?.tab?.url || message.payload?.url || ''
      });
      await setSteps(steps);
      sendResponse({ ok: true, stepsCount: steps.length });
      return;
    }

    if (message.type === 'QA_START_RECORDING') {
      await setSteps([]);
      await setRecording(true);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'QA_STOP_RECORDING') {
      await setRecording(false);
      const steps = await getSteps();
      sendResponse({ ok: true, steps });
      return;
    }

    if (message.type === 'QA_GET_RECORDING_STATE') {
      const recording = await isRecording();
      sendResponse({ ok: true, recording });
      return;
    }

    if (message.type === 'QA_SAVE_TESTCASE') {
      const { name, steps } = message.payload || {};
      const items = await getTestcases();
      const tc = {
        id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()),
        name: String(name || '').trim() || `Test Case ${items.length + 1}`,
        steps: Array.isArray(steps) ? steps : [],
        createdAt: Date.now()
      };
      items.unshift(tc);
      await setTestcases(items);
      sendResponse({ ok: true, testcase: tc, testcases: items });
      return;
    }

    if (message.type === 'QA_GET_TESTCASES') {
      const items = await getTestcases();
      sendResponse({ ok: true, testcases: items });
      return;
    }

    if (message.type === 'QA_DELETE_TESTCASE') {
      const { id } = message.payload || {};
      const items = await getTestcases();
      const next = items.filter((t) => t.id !== id);
      await setTestcases(next);
      sendResponse({ ok: true, testcases: next });
      return;
    }

    if (message.type === 'QA_GET_STEPS') {
      const steps = await getSteps();
      sendResponse({ ok: true, steps });
      return;
    }

    if (message.type === 'QA_CLEAR_STEPS') {
      await setSteps([]);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'QA_UPDATE_STEP') {
      const { index, patch } = message.payload || {};
      const steps = await getSteps();
      if (typeof index === 'number' && index >= 0 && index < steps.length && patch && typeof patch === 'object') {
        steps[index] = { ...steps[index], ...patch };
        await setSteps(steps);
      }
      sendResponse({ ok: true, steps });
      return;
    }

    if (message.type === 'QA_REMOVE_STEP') {
      const { index } = message.payload || {};
      const steps = await getSteps();
      if (typeof index === 'number' && index >= 0 && index < steps.length) {
        steps.splice(index, 1);
        await setSteps(steps);
      }
      sendResponse({ ok: true, steps });
      return;
    }

    if (message.type === 'QA_REORDER_STEPS') {
      const { fromIndex, toIndex } = message.payload || {};
      const steps = await getSteps();
      if (
        typeof fromIndex === 'number' &&
        typeof toIndex === 'number' &&
        fromIndex >= 0 &&
        toIndex >= 0 &&
        fromIndex < steps.length &&
        toIndex < steps.length
      ) {
        const [item] = steps.splice(fromIndex, 1);
        steps.splice(toIndex, 0, item);
        await setSteps(steps);
      }
      sendResponse({ ok: true, steps });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })();

  return true;
});
