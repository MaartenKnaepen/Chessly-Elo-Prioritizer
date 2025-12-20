(async function extractionPoliteMode() {
    console.log("🚀 Starting Polite Extraction (Serial Mode)...");

    // --- CONFIGURATION ---
    const TIMEOUT_MS = 10000; // Give up on a study after 10s
    const COOLDOWN_MS = 1500; // Wait 1.5s between studies to respect API limits

    // --- PHASE 1: COLLECT URLs (Proven Logic) ---
    const masterQueue = [];
    const getChapterNodes = () => document.querySelectorAll('div[id^="chapter-"]');
    const totalChapters = getChapterNodes().length;

    console.log(`📂 Found ${totalChapters} chapters. Scanning structure...`);

    for (let i = 0; i < totalChapters; i++) {
        const chapterNode = getChapterNodes()[i];
        const chapterTitle = chapterNode.querySelector('.Chapter_chapterTitle__sbxbv .bold13')?.innerText || `Chapter ${i+1}`;
        
        console.log(`   🔹 [${i+1}/${totalChapters}] Checking: ${chapterTitle}`);
        chapterNode.scrollIntoView({ behavior: 'auto', block: 'center' });
        await new Promise(r => setTimeout(r, 200));

        // Open if closed
        if (!chapterNode.className.includes('Chapter_open')) {
            const header = chapterNode.querySelector('.Chapter_chapterHeader__6R_A8');
            if (header) {
                header.click();
                // Wait for content
                await new Promise(resolve => {
                    let attempts = 0;
                    const check = setInterval(() => {
                        const freshNode = getChapterNodes()[i];
                        const studies = freshNode.querySelectorAll('.ChapterStudy_chapterStudyContainer___1hKE');
                        if (studies.length > 0 || attempts > 20) {
                            clearInterval(check);
                            resolve();
                        }
                        attempts++;
                    }, 100);
                });
            }
        }

        // Collect Links
        const freshNode = getChapterNodes()[i];
        const studyContainers = freshNode.querySelectorAll('.ChapterStudy_chapterStudyContainer___1hKE');
        
        studyContainers.forEach((studyNode, sIndex) => {
            const links = Array.from(studyNode.querySelectorAll('a'));
            const learnLink = links.find(a => 
                a.href.includes('/studies/') &&
                !a.href.endsWith('/video') && 
                !a.href.endsWith('/quizzes') && 
                !a.href.endsWith('/drill-shuffle')
            );
            if (learnLink) {
                masterQueue.push({
                    chapter: `Chapter ${i + 1}`,
                    study: `Study ${sIndex + 1}`,
                    url: learnLink.href
                });
            }
        });
    }

    console.log(`\n✅ PHASE 1 COMPLETE. Collected ${masterQueue.length} studies.`);
    if (masterQueue.length === 0) return console.error("❌ No studies found.");

    // --- PHASE 2: SERIAL CRAWLER (One by one) ---
    console.log("🚀 Starting Phase 2: Serial Extraction...");
    
    // Create ONE reusable iframe
    let iframe = document.getElementById('crawler_frame_master');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'crawler_frame_master';
        Object.assign(iframe.style, { position: 'absolute', width: '0', height: '0', visibility: 'hidden' });
        document.body.appendChild(iframe);
    }

    const results = [];

    // Process queue sequentially
    for (let i = 0; i < masterQueue.length; i++) {
        const task = masterQueue[i];
        
        // Progress Log
        console.log(`⏳ [${i + 1}/${masterQueue.length}] Extracting: ${task.chapter} - ${task.study}`);

        try {
            const lines = await fetchWithTimeout(iframe, task.url);
            
            lines.forEach((line, idx) => {
                results.push({
                    Chapter: task.chapter,
                    Study: task.study,
                    Variation: `Var ${idx + 1}`,
                    "Move Order": line
                });
            });

        } catch (err) {
            console.warn(`⚠️ Failed ${task.study}: ${err}`);
        }

        // COOLDOWN: Pause to let the server breathe
        if (i < masterQueue.length - 1) {
            await new Promise(r => setTimeout(r, COOLDOWN_MS));
        }
    }

    // --- FINISH ---
    document.body.removeChild(iframe);
    console.log("🎉 EXTRACTION SUCCESSFUL!");
    console.table(results);
    
    // Auto-Copy
    const jsonString = JSON.stringify(results, null, 2);
    try {
        const clipboardItem = new ClipboardItem({ "text/plain": new Blob([jsonString], { type: "text/plain" }) });
        await navigator.clipboard.write([clipboardItem]);
        console.log("📋 Data copied to clipboard!");
    } catch(e) {}

    // --- HELPER ---
    function fetchWithTimeout(iframe, url) {
        return new Promise((resolve, reject) => {
            let isResolved = false;

            // 1. Timeout Failsafe
            const timer = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    // Don't reject, just return empty so we keep going
                    resolve(["Error: Timeout"]);
                }
            }, TIMEOUT_MS);

            // 2. Load Handler
            iframe.onload = () => {
                if (isResolved) return;

                const doc = iframe.contentDocument || iframe.contentWindow.document;
                
                // Aggressive Polling
                let attempts = 0;
                const poll = setInterval(() => {
                    attempts++;
                    
                    // Look for the data
                    const link = Array.from(doc.querySelectorAll('a'))
                        .find(a => a.href && a.href.includes('analyze?lines='));

                    if (link) {
                        clearInterval(poll);
                        clearTimeout(timer);
                        isResolved = true;
                        
                        // Parse
                        const urlObj = new URL(link.href);
                        const lines = urlObj.searchParams.getAll('lines');
                        const cleanLines = lines.map(l => decodeURIComponent(l).replace(/,/g, ' '));
                        
                        // Navigate away to stop network requests immediately
                        iframe.src = 'about:blank';
                        
                        resolve(cleanLines);
                    } 
                    
                    // Stop polling after 8 seconds (leaving 2s buffer)
                    if (attempts > 80) {
                        clearInterval(poll);
                        if (!isResolved) {
                            isResolved = true;
                            iframe.src = 'about:blank';
                            resolve(["Error: Button not found"]); 
                        }
                    }
                }, 100);
            };

            // 3. Start
            iframe.src = url;
        });
    }

})();