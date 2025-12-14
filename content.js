// content.js
let lastAnalyzedHref = "";
let observer = null;
let moveObserver = null;
let isAnalyzing = false;
let debounceTimer = null;

// Start everything
initObserver();

// Listen for Popup settings changes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "refreshData") {
        console.log("Chessly ELO: Settings changed, forcing refresh...");
        lastAnalyzedHref = ""; // Force re-run
        runAnalysis();
    }
});

function initObserver() {
    console.log("Chessly ELO: Observers started.");
    
    // 1. Variation Observer (Watches for "Analyze" button / URL changes)
    observer = new MutationObserver((mutations) => {
        const analyzeLink = document.querySelector('a[href*="lines="]');
        if (analyzeLink) {
            if (analyzeLink.href !== lastAnalyzedHref) {
                lastAnalyzedHref = analyzeLink.href;
                runAnalysis();
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 2. Move Observer (Watches for moves played on board)
    moveObserver = new MutationObserver(() => {
        // Debounce to prevent lag when moves animate
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(updateHighlights, 300);
    });
    // Observing characterData matches text changes (e.g., move list updates)
    moveObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// Called by Observer and after Initial Draw
function updateHighlights() {
    // Only proceed if our table is actually on screen
    if (!document.getElementById("chessly-elo-table")) return;

    const moves = scrapeMovesFromPage();
    if (moves) {
        // Pass the moves to the renderer to update CSS classes
        ChesslyRenderer.highlightPath(moves);
    }
}

// Robust Scraper using chess.js validation
function scrapeMovesFromPage() {
    const allText = document.body.innerText;
    
    // Find anything that looks like a move (e4, Nf3, O-O, etc.)
    // Regex allows move numbers "1." but we filter them out
    const tokens = allText.match(/([0-9]+\.+)|([KQRBN]?[a-h]?[1-8])|(O-O-O)|(O-O)/g);
    
    if (!tokens) return [];

    const chess = new Chess();
    const cleanMoves = [];

    // Validate tokens to ensure they form a legal game
    for (let token of tokens) {
        // Skip numbers like "1."
        if (token.match(/^[0-9]+\.+$/)) continue;
        
        // Try playing the move
        const result = chess.move(token);
        if (result) {
            cleanMoves.push(result.san);
        }
    }

    // Heuristic: If we found < 1 move, we probably aren't looking at a move list.
    // If we found 50 moves in random text, the chess.js validation logic likely failed 
    // because random text rarely forms a legal 50-move chess game.
    
    return cleanMoves;
}

async function runAnalysis() {
    if (isAnalyzing) return;
    isAnalyzing = true;

    const analyzeLink = document.querySelector('a[href*="lines="]');
    if (!analyzeLink) { isAnalyzing = false; return; }

    ChesslyRenderer.showLoading();

    chrome.storage.local.get(['lowElo', 'highElo'], async (settings) => {
        const lowElo = settings.lowElo || "1600";
        const highElo = settings.highElo || "2000";

        try {
            const treeNodes = ChesslyLogic.buildTreeFromUrl(analyzeLink.href);
            if (!treeNodes) {
                ChesslyRenderer.showError("Could not parse variations.");
                isAnalyzing = false;
                return;
            }

            const dataMap = await ChesslyLogic.fetchDataForTree(treeNodes, lowElo, highElo);
            
            // 1. Draw the Table
            ChesslyRenderer.draw(treeNodes, dataMap, lowElo, highElo);
            
            // 2. Trigger Highlight check immediately after drawing
            updateHighlights();

        } catch (error) {
            console.error("Chessly ELO Error:", error);
            if (error.toString().includes("429")) {
                ChesslyRenderer.showError("Lichess Rate Limit Reached.<br>Please wait 60 seconds.");
            } else {
                ChesslyRenderer.showError("Failed to load data.");
            }
        } finally {
            isAnalyzing = false;
        }
    });
}