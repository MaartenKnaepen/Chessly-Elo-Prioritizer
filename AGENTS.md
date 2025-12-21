# 🧠 PROJECT INTELLIGENCE & GUIDELINES

## 🤖 Role & Protocol
**Identity:** You are Rovo, the Lead Performance Architect.
**Architect:** You take instructions from Gemini (via `.rovo-plan.md`).
**Source of Truth:** You strictly follow `.rovo-plan.md`. Do not hallucinate requirements outside of it.
**Mission:** Build a "Fast & Responsive" Chrome Extension. Latency is the enemy.

## 🔄 Workflow
1.  **Read:** Check `.rovo-plan.md` for the current task.
2.  **Implement:** Edit the codebase to satisfy the plan.
3.  **Verify:** Ensure your changes do not break existing logic.
4.  **Log:** Append a summary of your work to the "Project Memory" section at the bottom of this file.

## 🛡️ Universal Coding Standards

### 🚫 Anti-Lazy Rules
- **No Placeholders:** Never write comments like `// ... existing code ...`. Always write the full file content or use surgical replacements if your tool permits.
- **Preserve Context:** Do not delete comments or code sections unless explicitly instructed to refactor them.

### 🧩 Architecture: Chrome Extension (Manifest V3)
- **Service Worker Mindset:** Background scripts are ephemeral. **NEVER** rely on global variables for persistent state. They will be wiped when the worker goes idle (30s).
- **State Management:** Use `chrome.storage.local` for all state. It is the "database" of the extension.
- **Offscreen Documents:** Heavy DOM parsing (like the Chessly crawler) **MUST** happen in an Offscreen Document, not the Service Worker (which has no DOM) and not the Popup (which closes when the user clicks away).
- **Message Passing:** Minimize chatter. Send one large message with a payload rather than 50 small messages. Use "Fire and Forget" for logging.

### ⚡ JavaScript/TypeScript Performance Guidelines
- **Syntax:** Modern ES6+. Use `const` by default.
- **Async/Await:** Use `async/await` exclusively. Avoid callback hell, especially with Chrome APIs (wrap them in Promises if they don't support await natively).
- **Looping:**
  - *Bad:* `for (const item of items) { await process(item); }` (Sequential = Slow)
  - *Good:* `await Promise.all(items.map(process));` (Concurrent = Fast)
  - *Constraint:* When hitting external APIs (Lichess), implement **batching** or **throttling** to respect rate limits (`429`).
- **DOM Manipulation:**
  - Batch DOM updates. Do not write to the DOM inside a loop. Build a `documentFragment` or a template string and inject it once.
  - Use `requestAnimationFrame` for UI updates if they are rapid.
- **Safety:** Use Optional Chaining (`obj?.prop`) and Nullish Coalescing (`val ?? default`) to prevent runtime crashes.
- **Error Handling:** Every `fetch` or asynchronous Chrome API call must have a `try/catch` block. Fail silently or log to debug, but never crash the extension.

### 🐍 Python Guidelines (Backend/Scripts)
- **Tooling:** We use `uv`.
- **Typing:** Use Python 3.10+ Type Hints (`list[str]`, `str | None`).
- **Paths:** Use `pathlib.Path`.
- **Strings:** Use f-strings (`f"{var}"`).

## 📝 Project Memory
*(Rovo will append completed tasks below with a timestamp)*
---------------------------------------------------------

### 2025-12-20 14:37 UTC - Initial Extension Architecture Implemented
**Task:** Implemented high-performance Chrome Extension architecture per `.rovo-plan.md`

**Completed:**
- ✅ Created Vite + React + TypeScript build configuration
- ✅ Configured `@crxjs/vite-plugin` for Manifest V3 bundling
- ✅ Implemented Offscreen Document (`src/offscreen/`) for DOM-based crawling
  - `index.html`: Minimal HTML shell
  - `crawler.ts`: Polite & Persistent crawl logic (serial iframe recycling, 1.5s cooldown)
- ✅ Implemented Background Service Worker (`src/background/index.ts`)
  - Offscreen document lifecycle management
  - FEN generation pipeline using `chess.js`
  - Lichess API integration with 1 req/sec throttling
  - Persistent state management via `chrome.storage.local`
- ✅ Implemented Popup UI (`src/popup/`)
  - `App.tsx`: Clean React UI with status tracking
  - Real-time progress updates (crawling → enriching → complete)
  - Export to JSON functionality
  - Responsive design with status indicators
- ✅ Defined shared TypeScript interfaces (`src/types.ts`)
- ✅ Successfully built extension (`npm run build` → `dist/`)

**Architecture Highlights:**
- **No global state in Service Worker** (ephemeral-safe)
- **Message passing** for background ↔ offscreen ↔ popup communication
- **Throttled API calls** to respect Lichess rate limits
- **Sequential iframe crawling** to avoid overwhelming Chessly servers

**Next Steps:**
- Test extension in Chrome (`chrome://extensions` → Load `dist/` folder)
- Implement Phase 1 URL collection (requires content script or tab access)
- Add error recovery and retry logic
- Optimize Lichess API batching for even faster enrichment

### 2025-12-20 15:00 UTC - Content Script Bridge Implementation Complete
**Task:** Implemented the Content Script to bridge the gap between the UI and the crawler pipeline per `.rovo-plan.md`

**Completed:**
- ✅ Updated `src/types.ts` with new message types
  - Added `SCAN_PAGE` and `SCAN_COMPLETE` message types
  - Added `ScanCompletePayload` and `StartCrawlPayload` interfaces
- ✅ Created Content Script (`src/content/index.ts`)
  - Smart chapter expansion logic (detects collapsed chapters and expands them)
  - Polls for content appearance after expansion (800ms delay, max 10 attempts)
  - Extracts study URLs from each chapter
  - Sends `SCAN_COMPLETE` message to background with collected tasks
  - Visual indicator shows when content script is active
- ✅ Registered content script in `src/manifest.json`
  - Matches: `https://chessly.com/*`
  - Run at: `document_idle` for optimal performance
- ✅ Updated Background Orchestrator (`src/background/index.ts`)
  - New flow: Popup → Background → Content Script (scan) → Background → Offscreen (crawl)
  - `handleStartCrawl` now queries active tab and sends `SCAN_PAGE`
  - Added `handleScanComplete` to receive tasks and forward to offscreen
  - Validates user is on Chessly page before starting
- ✅ Updated Offscreen Crawler (`src/offscreen/crawler.ts`)
  - Now accepts tasks via `StartCrawlPayload` in the `START_CRAWL` message
  - Removed placeholder `collectStudyUrls` function (now done by content script)
  - Direct flow: receives tasks → extracts data → returns results
- ✅ Successfully built and tested pipeline (`npm run build`)

**Architecture Flow:**
1. User clicks "Start Extraction" in Popup
2. Background queries active tab and sends `SCAN_PAGE` to Content Script
3. Content Script scans page, expands chapters, extracts study URLs
4. Content Script sends `SCAN_COMPLETE` with tasks array to Background
5. Background creates Offscreen Document and sends `START_CRAWL` with tasks
6. Offscreen Document crawls each study URL sequentially
7. Offscreen sends `CRAWL_COMPLETE` with raw data to Background
8. Background enriches data with FEN + Lichess stats
9. Background stores enriched data and updates Popup status

**Performance Optimizations:**
- Content script waits for DOM to be idle before injecting
- Chapter expansion uses polling with timeout protection
- Single reusable iframe in offscreen for memory efficiency
- 1.5s cooldown between study crawls to be polite to Chessly servers
- 1 req/sec throttling for Lichess API calls

**Next Steps:**
- Load extension in Chrome and test on real Chessly repertoire page
- Add error recovery for network failures
- Implement retry logic for failed studies
- Consider adding progress indicators during content script scan phase

### 2025-12-21 11:43 UTC - Content Script Selector & Filter Fixes
**Task:** Fixed Content Script to correctly detect React-generated class names and filter study URLs per `.rovo-plan.md`

**Problem:**
- Content script failed to detect collapsed chapters due to incorrect class selectors
- React generates dynamic class names like `Chapter_chapterHeader__...` and `Chapter_open`
- Content script was extracting all study-related links (video, quiz, drill) instead of just the "Learn" link

**Completed:**
- ✅ Refactored `isChapterCollapsed()` function
  - Now checks if `chapterDiv.className` includes `"Chapter_open"` or `"open"`
  - Returns `false` (expanded) if class contains "open", `true` (collapsed) otherwise
  - Simplified logic removes unreliable heuristics
- ✅ Refactored `expandChapter()` function
  - Updated click selector to prioritize `div[class*="Chapter_chapterHeader"]`
  - Matches React-generated class names correctly
  - Kept fallback selectors for robustness
- ✅ Refactored `extractStudiesFromChapter()` function
  - Changed selector from `a[href*="study"]` to `a[href*="/studies/"]` (more specific)
  - Added filtering logic to exclude non-study links:
    - Skip URLs ending in `/video`
    - Skip URLs ending in `/quizzes`
    - Skip URLs ending in `/drill-shuffle`
  - Only extracts the clean "Learn" study links
- ✅ Successfully built extension (`npm run build`)

**Technical Details:**
- Detection now relies on React's class naming pattern instead of DOM structure assumptions
- Filter uses `.endsWith()` check for precise exclusion
- Maintains backward compatibility with fallback selectors

**Expected Behavior After Fix:**
1. Script should log `🔓 Expanding chapter...` when chapters are collapsed
2. Script should wait for content to appear after expansion
3. Script should log `✅ Found X studies` with accurate count (excluding video/quiz/drill)
4. Popup should display correct progress count matching real study count

**Next Steps:**
- Reload extension in Chrome (`chrome://extensions` → Developer mode → Update)
- Refresh the Chessly repertoire page
- Run "Start Extraction" and verify console logs show correct detection and filtering
- Verify extracted data only contains study links, not video/quiz/drill links