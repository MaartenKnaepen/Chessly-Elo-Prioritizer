# 🛠️ Technical Documentation

This document outlines the architecture, logic, and data flow of the **Chessly ELO Prioritizer** extension.

## 🏗️ Architecture

The extension follows the **Manifest V3** standard and operates with a clean separation of concerns.

```text
chessly_extension/
├── manifest.json       # Configuration & Permissions
├── background.js       # Service Worker (API Communication)
├── content.js          # Coordinator (DOM Observer & Event Wiring)
├── logic.js            # Business Logic (Tree Building, Caching, Recursive parsing)
├── renderer.js         # UI Logic (HTML Generation, Dragging, CSS)
├── popup.html/js       # User Settings (ELO Input)
└── chess.js            # Chess logic library (Move validation/FEN generation)
```

## 🔄 Data Flow Diagram

1.  **User Opens Chessly**
2.  `content.js` initializes & scrapes variation URLs
3.  `logic.js` builds tree structure
4.  Checks **Cache** (Chrome Local Storage)
    *   *Cache Miss?* `background.js` fetches from Lichess API
5.  Result cached (24h TTL)
6.  `renderer.js` draws table
7.  **User plays move** → `moveObserver` triggers → Highlights active path

## 🧠 Core Logic

### 1. The Tree Builder (`logic.js`)
The core challenge is converting a flat list of variations (provided by Chessly's URL parameters) into a hierarchical tree.
*   **Input:** Arrays of moves (e.g., `['e4', 'e5', 'Nf3']`, `['e4', 'e5', 'f4']`).
*   **Recursion:** The `recursiveTreeBuilder` function iterates through moves, identifying "Split Indices" where variations diverge.
*   **FEN Calculation:** It uses `chess.js` to calculate the FEN (Forsyth–Edwards Notation) at the position **before** the diverging move is played. This allows us to query the Lichess API for "Next Move candidates" from that specific position.

### 2. Move Scraping & Synchronization (`content.js`)
To implement "Active Highlighting," the extension must track the current board state without accessing Chessly's internal React state.
*   **Strategy:** It scrapes the DOM using `document.body.innerText`, extracting chess notation tokens via regex (e.g., "1.", "Nf3", "O-O").
*   **Validation:** To prevent false positives (like blog text), every scraped token is validated against a virtual `chess.js` game instance. If the move is illegal in the current sequence, it is discarded.
*   **Matching:** The renderer matches the scraped game history against the `data-path` attribute injected into every table row.

### 3. Observer Pattern
The extension uses three observers to maintain reactivity:
1.  **Variation Observer:** Watches `href` attribute changes on variation links (detecting when the user switches chapters).
2.  **Move Observer:** Watches for board state changes (detecting when a move is played).
3.  **Message Listener:** Responds to popup settings changes (Current/Target ELO updates).

All observers are debounced (300ms) to prevent excessive re-rendering or API calls during rapid inputs.

## ⚡ Performance Optimizations
*   **Parallel API Calls:** Low and High ELO data are fetched simultaneously via `Promise.all()`.
*   **Daily Cache Rotation:** Keys include a day index that rotates every 24 hours. Old entries are automatically pruned to respect Chrome's 10MB local storage limit.
*   **Debounced Observers:** Prevents UI lag during animation sequences.
*   **Fire-and-Forget Cache Cleanup:** Pruning logic runs non-blocking on each analysis execution.

## 🔌 API Usage

We interact with the **Lichess Explorer API**.

*   **Endpoint:** `https://explorer.lichess.ovh/lichess`
*   **Method:** `GET`
*   **Parameters:**
    *   `fen`: The board position.
    *   `speeds`: `blitz,rapid,classical` (Standard time controls).
    *   `ratings`: Dynamic based on user settings (e.g., `1600`, `2000`).

**Rate Limiting:** We handle `429 Too Many Requests` errors in `background.js` and pass a flag to the UI, which displays a user-friendly message asking them to wait 60 seconds.

## 🛡️ Error Handling Strategy
*   **API Errors:** Not cached; transient failures can be retried on next page load or manual refresh.
*   **Rate Limits:** Specific UI feedback provided to the user.
*   **Race Conditions:** Boolean semaphore (`isAnalyzing`) prevents concurrent analysis runs if a user double-clicks refresh.
*   **Division by Zero:** Protected against in win rate calculations (e.g., rare lines with 0 games).

## ⚠️ Known Limitations

*   **DOM Dependency:** The move scraper relies on moves being present in the DOM text. If Chessly changes their rendering approach (e.g., to a canvas-based board without accessible text), the scraper may need updates.
*   **Rate Limits:** Heavy usage (rapidly clicking through many chapters) may trigger Lichess IP rate limits (~100 requests/minute).