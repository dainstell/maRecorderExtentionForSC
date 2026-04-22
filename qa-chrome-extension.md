I want you to build a production-ready Chrome Extension (Manifest V3) that records user interactions on any webpage and converts them into test case steps.

Requirements:

1. Capture events:
   - click
   - input
   - change

2. For each event capture:
   - action type
   - element text (innerText)
   - tag name
   - data-cy attribute (priority)
   - id
   - CSS selector
   - XPath (fallback)

3. Selector priority:
   1. data-cy
   2. id
   3. unique CSS selector
   4. XPath

4. Generate readable test steps like:
   "Click Login button"
   "Type email into Email input"

5. Store steps in memory and display in popup UI

6. Add export feature:
   - JSON
   - Cypress format

7. Avoid duplicate events (debounce)

8. Code structure:
   - content.js
   - background.js
   - popup.html/js
   - utils/selectors.js

9. Use clean, maintainable, modular code

10. Add comments explaining logic

Return full working extension code.