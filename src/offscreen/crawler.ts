/**
 * Offscreen Document Crawler
 * Implements the "Polite & Persistent" logic from chessly_crawler.js
 * Runs in a hidden offscreen document to avoid blocking the UI
 */

import type { CrawlTask, RawExtractedLine, Message, CrawlProgressPayload, CrawlCompletePayload, StartCrawlPayload, StudyExtractedPayload } from '../types';

// Configuration
const TIMEOUT_MS = 10000; // Give up on a study after 10s
const COOLDOWN_MS = 1500; // Wait 1.5s between studies to respect API limits

console.log('🔧 Offscreen crawler initialized');

// Listen for crawl requests from the background script
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'START_CRAWL') {
    console.log('🚀 Received START_CRAWL message');
    
    const payload = message.payload as StartCrawlPayload;
    
    if (!payload || !payload.tasks || payload.tasks.length === 0) {
      console.error('❌ No tasks provided in START_CRAWL message');
      chrome.runtime.sendMessage({
        type: 'CRAWL_ERROR',
        payload: { error: 'No tasks provided' }
      });
      sendResponse({ status: 'error', error: 'No tasks provided' });
      return true;
    }
    
    startCrawl(payload.tasks).catch(error => {
      console.error('❌ Crawl failed:', error);
      chrome.runtime.sendMessage({
        type: 'CRAWL_ERROR',
        payload: { error: error.message }
      });
    });
    sendResponse({ status: 'started' });
    return true;
  }
});

/**
 * Main crawl orchestrator
 * Now receives tasks directly from the background (via content script scan)
 * Streams results per-study instead of batching at the end
 */
async function startCrawl(tasks: CrawlTask[]): Promise<void> {
  console.log(`🚀 Starting Polite Extraction (Streaming Mode) with ${tasks.length} tasks...`);

  // PHASE 2: Serial Extraction with streaming results
  await extractAllStudies(tasks);

  // Send completion signal (no payload needed - lines already streamed)
  console.log('🎉 EXTRACTION SUCCESSFUL!');
  chrome.runtime.sendMessage({
    type: 'CRAWL_COMPLETE',
    payload: {
      lines: [],  // Empty - we already streamed the lines
      count: 0
    } as CrawlCompletePayload
  });
}

/**
 * PHASE 2: Extract data from all studies sequentially
 * STREAMING: Send results immediately after each study is extracted
 */
async function extractAllStudies(tasks: CrawlTask[]): Promise<void> {
  console.log('🚀 Starting Phase 2: Serial Extraction (Streaming Mode)...');
  
  // Create ONE reusable iframe
  let iframe = document.getElementById('crawler_frame_master') as HTMLIFrameElement | null;
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'crawler_frame_master';
    Object.assign(iframe.style, {
      position: 'absolute',
      width: '0',
      height: '0',
      visibility: 'hidden'
    });
    document.body.appendChild(iframe);
  }

  // Process queue sequentially
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    
    // Send progress update
    chrome.runtime.sendMessage({
      type: 'CRAWL_PROGRESS',
      payload: {
        current: i + 1,
        total: tasks.length,
        currentTask: `${task.chapter} - ${task.study}`
      } as CrawlProgressPayload
    });

    console.log(`⏳ [${i + 1}/${tasks.length}] Extracting: ${task.chapter} - ${task.study}`);

    try {
      const lines = await fetchWithTimeout(iframe, task.url);
      
      // Build the raw extracted lines for this study
      const rawLines: RawExtractedLine[] = lines.map((line, idx) => ({
        Chapter: task.chapter,
        Study: task.study,
        Variation: `Var ${idx + 1}`,
        'Move Order': line
      }));

      // STREAM: Send this study's results immediately to background
      chrome.runtime.sendMessage({
        type: 'STUDY_EXTRACTED',
        payload: {
          courseName: task.courseName,
          lines: rawLines
        } as StudyExtractedPayload
      });

      console.log(`✅ Streamed ${rawLines.length} lines from ${task.study}`);

    } catch (err) {
      console.warn(`⚠️ Failed ${task.study}:`, err);
    }

    // COOLDOWN: Pause to let the server breathe
    if (i < tasks.length - 1) {
      await new Promise(r => setTimeout(r, COOLDOWN_MS));
    }
  }

  // Cleanup
  if (iframe.parentNode) {
    document.body.removeChild(iframe);
  }
}

/**
 * Fetch a single study with timeout protection
 */
function fetchWithTimeout(iframe: HTMLIFrameElement, url: string): Promise<string[]> {
  return new Promise((resolve) => {
    let isResolved = false;

    // 1. Timeout Failsafe
    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        // Don't reject, just return empty so we keep going
        resolve(['Error: Timeout']);
      }
    }, TIMEOUT_MS);

    // 2. Load Handler
    iframe.onload = () => {
      if (isResolved) return;

      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) {
        clearTimeout(timer);
        resolve(['Error: Cannot access iframe document']);
        return;
      }
      
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
            resolve(['Error: Button not found']); 
          }
        }
      }, 100);
    };

    // 3. Start
    iframe.src = url;
  });
}
