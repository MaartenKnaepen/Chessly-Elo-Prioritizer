document.addEventListener('DOMContentLoaded', () => {
    // 1. Load saved settings or defaults
    chrome.storage.local.get(['lowElo', 'highElo'], (result) => {
        document.getElementById('lowElo').value = result.lowElo || "1600";
        document.getElementById('highElo').value = result.highElo || "2000";
    });

    // 2. Save settings when button clicked
    document.getElementById('saveBtn').addEventListener('click', () => {
        const low = document.getElementById('lowElo').value;
        const high = document.getElementById('highElo').value;

        // --- VALIDATION FIX ---
        if (parseInt(low) >= parseInt(high)) {
            const btn = document.getElementById('saveBtn');
            const originalText = btn.innerText;
            
            btn.innerText = "❌ Target must be higher!";
            btn.style.background = "#d64545"; // Red color
            
            setTimeout(() => {
                btn.innerText = originalText;
                btn.style.background = "#86c246";
            }, 2000);
            
            return; // STOP execution
        }

        chrome.storage.local.set({ lowElo: low, highElo: high }, () => {
            // 3. Send message to active tab to refresh immediately
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, { action: "refreshData" });
                }
            });
            window.close();
        });
    });
});