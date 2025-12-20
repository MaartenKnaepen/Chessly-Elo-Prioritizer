/**
 * Offscreen Document Crawler
 * Implements the "Polite & Persistent" logic from chessly_crawler.js
 * Runs in a hidden offscreen document to avoid blocking the UI
 */

import type { CrawlTask, RawExtractedLine, Message, CrawlProgressPayload, CrawlCompletePayload } from '../types';

// Configuration
const TIMEOUT_MS = 10000; // Give up on a study after 10s
const COOLDOWN_MS = 1500; // Wait 1.5s between studies to respect API limits

console.log('🔧 Offscreen crawler initialized');

// Listen for crawl requests from the background script
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'START_CRAWL') {
    console.log('🚀 Received START_CRAWL message');
    startCrawl().catch(error => {
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
 */
async function startCrawl(): Promise<void> {
  console.log('🚀 Starting Polite Extraction (Serial Mode)...');

  // PHASE 1: Collect URLs from the main Chessly page
  const masterQueue = await collectStudyUrls();
  
  if (masterQueue.length === 0) {
    console.error('❌ No studies found.');
    chrome.runtime.sendMessage({
      type: 'CRAWL_ERROR',
      payload: { error: 'No studies found on the page' }
    });
    return;
  }

  console.log(`✅ PHASE 1 COMPLETE. Collected ${masterQueue.length} studies.`);

  // PHASE 2: Serial Extraction
  const results = await extractAllStudies(masterQueue);

  // Send results back to background
  console.log('🎉 EXTRACTION SUCCESSFUL!');
  chrome.runtime.sendMessage({
    type: 'CRAWL_COMPLETE',
    payload: {
      lines: results,
      count: results.length
    } as CrawlCompletePayload
  });
}

/**
 * PHASE 1: Collect all study URLs from the Chessly repertoire page
 * This needs to be done in a content script or by fetching the page
 * For now, we'll implement a placeholder that expects the background to provide URLs
 */
async function collectStudyUrls(): Promise<CrawlTask[]> {
  // In a real implementation, we would:
  // 1. Fetch the Chessly repertoire page
  // 2. Parse the DOM to find all chapter/study links
  // 3. Return them as CrawlTask[]
  
  // For now, return an empty array - the background script will need to
  // inject a content script to collect these URLs first
  console.warn('⚠️ URL collection not implemented in offscreen yet');
  return [];
}

/**
 * PHASE 2: Extract data from all studies sequentially
 */
async function extractAllStudies(tasks: CrawlTask[]): Promise<RawExtractedLine[]> {
  console.log('🚀 Starting Phase 2: Serial Extraction...');
  
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

  const results: RawExtractedLine[] = [];

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
      
      lines.forEach((line, idx) => {
        results.push({
          Chapter: task.chapter,
          Study: task.study,
          Variation: `Var ${idx + 1}`,
          'Move Order': line
        });
      });

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

  return results;
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
