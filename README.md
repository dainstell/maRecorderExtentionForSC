# MA Recorder Extension for SC

A Chrome Extension (Manifest V3) that records user interactions on web pages and converts them into test case steps.

## Features

- Records:
  - click
  - input (records after you stop typing)
  - change
- Element locator priority:
  - data-cy
  - id
  - unique CSS selector
  - XPath (fallback)
- Step management:
  - delete steps
  - edit step text (and value for input/change)
  - add expected result per step
- Recording sessions:
  - Start / Stop
  - Save as Test Case
  - History (saved test cases)
- Export:
  - JSON
  - Cypress
  - CSV (Tuskr import format) + auto-download

## Install (Developer Mode)

1. Open Chrome and go to:
   - `chrome://extensions`
2. Enable:
   - **Developer mode**
3. Click:
   - **Load unpacked**
4. Select this folder from the repo:
   - `qa-chrome-extension/`

## How to use

- Open the extension popup.
- Click **Start** to begin a new recording session.
- Interact with your target website (click / type / change).
- Use **Open Recorder** to open the persistent Recorder page in a tab (recommended).
- Click **Stop** to stop recording.
- Click **Save Test Case** to store the recorded steps in History.

### Step tools

For each step you can:

- **Remove**: delete the step
- **Expected**: add/edit expected result text
- **Edit**: edit the step text (and input/change value)

## Export

### Tuskr CSV

- Use **Export CSV (Tuskr)** to generate a CSV compatible with Tuskr import.
- The export uses Tuskr step formatting:
  - steps are separated with `+++`
  - instructions and expected results are separated with `>>>`

The CSV will be shown in the export textbox and also downloaded automatically.

## Updating

- Pull the latest changes (or re-download the repo).
- Go to `chrome://extensions`.
- Find the extension and click **Reload**.

## Notes

- Popup windows close automatically when they lose focus (Chrome behavior). Use **Open Recorder** for a persistent view.
- Permissions:
  - `host_permissions: <all_urls>` is required to record interactions on all pages.

