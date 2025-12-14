// renderer.js
const ChesslyRenderer = {
    
    showLoading: function() {
        this.createOrUpdateContainer(`
            <div style="padding:15px; color:#aaa; text-align:center; font-size:13px;">
                <div style="margin-bottom:5px;">⏳ Loading Lichess Data...</div>
                <div style="font-size:10px; color:#666;">Please wait</div>
            </div>
        `);
    },

    showError: function(msg) {
        this.createOrUpdateContainer(`
            <div style="padding:15px; color:#d64545; text-align:center; font-size:13px;">
                <div style="margin-bottom:5px;">⚠️ Error</div>
                <div style="font-size:11px; color:#ccc;">${msg}</div>
            </div>
        `);
    },

    createOrUpdateContainer: function(innerHtml) {
        let container = document.getElementById("chessly-elo-table");
        if (!container) {
            container = document.createElement("div");
            container.id = "chessly-elo-table";
            container.style.cssText = `
                position: fixed; z-index: 10000;
                background: #1b1b1b; color: #e0e0e0; padding: 0;
                border: 1px solid #444; border-radius: 8px; 
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                box-shadow: 0 10px 40px rgba(0,0,0,0.6); min-width: 250px;
                overflow: hidden;
            `;
            document.body.appendChild(container);

            // Restore Position
            chrome.storage.local.get(['uiPosLeft', 'uiPosTop'], (res) => {
                if (res.uiPosLeft) { 
                    container.style.left = res.uiPosLeft; 
                    container.style.top = res.uiPosTop; 
                } else {
                    container.style.bottom = "20px";
                    container.style.right = "20px";
                }
            });
        }
        container.innerHTML = innerHtml;
        return container;
    },

    draw: function(treeNodes, dataMap, lowLabel, highLabel) {
        // --- 1. CSS INJECTION ---
        // We inject styles directly into the HTML string to ensure classes exist
        const html = `
            <style>
                .chessly-row { transition: background 0.2s, opacity 0.2s; }
                .chessly-dimmed { opacity: 0.3; filter: grayscale(100%); }
                .chessly-active { background: #323842 !important; }
                .chessly-highlight { border-left: 3px solid #86c246; background: #2f2f2f; }
            </style>

            <div id="chessly-header" style="background:#222; padding:10px 15px; border-bottom:1px solid #444; display:flex; justify-content:space-between; align-items:center; cursor: move; user-select: none;">
                <strong style="color:#fff; font-size:13px;">Variation Analysis</strong>
                <div>
                    <span id="chessly-min-btn" title="Minimize" style="cursor:pointer; color:#888; margin-right:12px; font-weight:bold; font-size:14px;">_</span>
                    <span id="chessly-close-btn" title="Close" style="cursor:pointer; color:#888; font-weight:bold; font-size:14px;">✕</span>
                </div>
            </div>
            
            <div id="chessly-table-content">
                <table style="width:100%; border-collapse: collapse; font-size: 12px;">
                    <tr style="background:#2a2a2a; color: #aaa; text-align:center;">
                        <th style="text-align:left; padding:8px 15px;">Move Flow</th>
                        <th colspan="2" style="padding:8px; border-left:1px solid #444;">${lowLabel} ELO</th>
                        <th colspan="2" style="padding:8px; border-left:1px solid #444;">${highLabel} ELO</th>
                    </tr>
                    ${this.generateRows(treeNodes, dataMap)}
                </table>
            </div>
        `;

        const container = this.createOrUpdateContainer(html);
        container.style.minWidth = "440px";

        this.attachListeners(container);
        this.makeDraggable(container);
    },

    generateRows: function(treeNodes, dataMap) {
        let rows = '';
        treeNodes.forEach((node, index) => {
            const apiData = dataMap.get(node.fen);
            const low = this.extractStats(apiData ? apiData.low : null, node.move, node.fen);
            const high = this.extractStats(apiData ? apiData.high : null, node.move, node.fen);
            
            const winLowColor = this.getWinColor(low.win);
            const winHighColor = this.getWinColor(high.win);

            const indentPx = node.depth * 15; 
            const arrow = node.depth > 0 ? `<span style="color:#555; margin-right:4px;">↳</span>` : ``;
            const rowBg = index % 2 === 0 ? 'transparent' : '#222';
            
            let badges = '';
            if (node.label && node.label.length > 0) {
                badges = node.label.split(', ').map(id => 
                    `<span style="background:#333; color:#aaa; padding:1px 4px; border-radius:3px; font-size:9px; margin-right:3px;">${id}</span>`
                ).join('');
            }

            // --- 2. DATA ATTRIBUTE FIX ---
            // Ensure path exists before joining, safeguard against undefined
            const pathStr = node.path ? node.path.join(',') : '';

            rows += `
                <tr class="chessly-row" data-path="${pathStr}" style="background:${rowBg}; border-bottom: 1px solid #333;">
                    <td style="padding:6px 15px; padding-left:${15 + indentPx}px; white-space:nowrap;">
                        ${arrow}
                        <strong style="color:#e0e0e0; margin-right:5px;">${node.move}</strong>
                        <span style="font-size:10px; color:#666; margin-right:8px;">(${node.moveNumber})</span>
                        ${badges}
                    </td>
                    <td style="padding:6px; text-align:center; border-left:1px solid #444;">${low.freq}</td>
                    <td style="padding:6px; text-align:center; color:${winLowColor}; font-weight:bold;">${low.win}</td>
                    <td style="padding:6px; text-align:center; border-left:1px solid #444; color:#aaa;">${high.freq}</td>
                    <td style="padding:6px; text-align:center; color:${winHighColor};">${high.win}</td>
                </tr>
            `;
        });
        return rows;
    },

    highlightPath: function(playedMoves) {
        const rows = document.querySelectorAll('.chessly-row');
        if (!rows.length) return;

        rows.forEach(row => {
            const pathAttr = row.getAttribute('data-path');
            if (!pathAttr) return;

            const rowPath = pathAttr.split(',');
            
            // Logic: Is this row part of the current board state?
            // 1. Exact match of history (we played this already)
            const isHistory = rowPath.length <= playedMoves.length && 
                              rowPath.every((m, i) => m === playedMoves[i]);

            // 2. Exact next candidate (we are about to play this)
            const isNext = rowPath.length === playedMoves.length + 1 && 
                           playedMoves.every((m, i) => m === rowPath[i]);

            // Reset
            row.classList.remove('chessly-dimmed', 'chessly-active', 'chessly-highlight');

            if (isNext) {
                row.classList.add('chessly-active'); // Brighten next moves
            } else if (isHistory) {
                // Determine if this was the VERY LAST move played
                if (rowPath.length === playedMoves.length) {
                    row.classList.add('chessly-highlight'); // Green border
                }
                // History moves stay normal opacity
            } else {
                row.classList.add('chessly-dimmed'); // Fade out divergent paths
            }
        });
    },

    extractStats: function(data, moveSan, fen) {
        if (!data || !data.moves) return { freq: "-", win: "-" };
        const moveStats = data.moves.find(m => m.san === moveSan);
        if (!moveStats) return { freq: "0%", win: "-" };
        const total = data.white + data.draws + data.black;
        if (total === 0) return { freq: "0%", win: "-" };
        const moveTotal = moveStats.white + moveStats.draws + moveStats.black;
        const freq = ((moveTotal / total) * 100).toFixed(0) + "%";
        const turn = fen.split(' ')[1];
        let winPct = 0;
        if (moveTotal > 0) {
            if (turn === 'w') winPct = (moveStats.white / moveTotal) * 100;
            else winPct = (moveStats.black / moveTotal) * 100;
        }
        return { freq, win: winPct.toFixed(0) + "%" };
    },

    getWinColor: function(winStr) {
        if (winStr === "-") return '#ccc';
        const val = parseInt(winStr);
        if (val > 50) return '#86c246';
        if (val < 40) return '#d64545';
        return '#ccc'; 
    },

    attachListeners: function(container) {
        document.getElementById("chessly-close-btn").addEventListener("click", () => container.remove());
        document.getElementById("chessly-min-btn").addEventListener("click", () => {
            const content = document.getElementById("chessly-table-content");
            content.style.display = content.style.display === "none" ? "block" : "none";
        });
    },

    makeDraggable: function(el) {
        const header = document.getElementById("chessly-header");
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            el.style.bottom = 'auto'; el.style.right = 'auto';
            el.style.left = `${initialLeft}px`; el.style.top = `${initialTop}px`;
            header.style.cursor = 'grabbing';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            el.style.left = `${initialLeft + (e.clientX - startX)}px`;
            el.style.top = `${initialTop + (e.clientY - startY)}px`;
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                header.style.cursor = 'move';
                chrome.storage.local.set({ uiPosLeft: el.style.left, uiPosTop: el.style.top });
            }
        });
    }
};