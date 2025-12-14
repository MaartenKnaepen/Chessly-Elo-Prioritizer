const BASE_URL = "https://explorer.lichess.ovh/lichess";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchStats") {
    
    const params = new URLSearchParams({
      variant: "standard",
      fen: request.fen,
      speeds: "blitz,rapid,classical",
      ratings: request.rating
    });

    fetch(`${BASE_URL}?${params.toString()}`)
      .then(async res => {
        if (!res.ok) {
            // Pass HTTP errors (like 429 Too Many Requests)
            throw new Error(`Lichess API Error: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        sendResponse({ data: data });
      })
      .catch(err => {
        // --- ERROR HANDLING FIX ---
        console.error("Background Fetch Error:", err);
        // Send the specific error message back
        sendResponse({ data: null, error: err.message });
      });

    return true; // Keep channel open
  }
});