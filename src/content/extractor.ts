/**
 * Extractor Content Script
 * Runs on Chessly study pages in a Worker Tab
 * Extracts move data from the "Analyze" button when commanded by Background
 */

import type { Message, StudyExtractedPayload, RawExtractedLine } from '../types';

console.log('🔧 Extractor script loaded');

// Configuration
const POLL_TIMEOUT_MS = 5000; // Give up after 5 seconds
const POLL_INTERVAL_MS = 100; // Check every 100ms

// Listen for extraction commands from Background
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'EXTRACT_MOVES') {
    console.log('🚀 Received EXTRACT_MOVES command');
    
    // Extract the task metadata from the message payload
    const { courseName, chapter, study } = message.payload as { 
      courseName: string; 
      chapter: string; 
      study: string;
    };
    
    // Start extraction
    extractMoves(courseName, chapter, study)
      .then(() => {
        sendResponse({ status: 'success' });
      })
      .catch((error) => {
        console.error('❌ Extraction failed:', error);
        sendResponse({ status: 'error', error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
});

/**
 * Extract moves from the current study page
 */
async function extractMoves(courseName: string, chapter: string, study: string): Promise<void> {
  console.log(`🔍 Extracting: ${chapter} - ${study}`);
  
  // Wait for the "Analyze" button to appear
  const analyzeLink = await waitForAnalyzeButton();
  
  if (!analyzeLink) {
    console.warn('⚠️ Analyze button not found - page may not have loaded correctly');
    
    // Send empty result to Background so it can continue
    chrome.runtime.sendMessage({
      type: 'STUDY_EXTRACTED',
      payload: {
        courseName,
        lines: []
      } as StudyExtractedPayload
    });
    return;
  }
  
  // Parse the URL
  const urlObj = new URL(analyzeLink.href);
  const lines = urlObj.searchParams.getAll('lines');
  
  if (lines.length === 0) {
    console.warn('⚠️ No lines found in analyze link');
    
    chrome.runtime.sendMessage({
      type: 'STUDY_EXTRACTED',
      payload: {
        courseName,
        lines: []
      } as StudyExtractedPayload
    });
    return;
  }
  
  // Clean and format the lines
  const cleanLines = lines.map(l => decodeURIComponent(l).replace(/,/g, ' '));
  
  // Build raw extracted lines
  const rawLines: RawExtractedLine[] = cleanLines.map((line, idx) => ({
    Chapter: chapter,
    Study: study,
    Variation: `Var ${idx + 1}`,
    'Move Order': line
  }));
  
  console.log(`✅ Extracted ${rawLines.length} lines`);
  
  // Send results to Background
  chrome.runtime.sendMessage({
    type: 'STUDY_EXTRACTED',
    payload: {
      courseName,
      lines: rawLines
    } as StudyExtractedPayload
  });
}

/**
 * Wait for the Analyze button to appear (with timeout)
 */
async function waitForAnalyzeButton(): Promise<HTMLAnchorElement | null> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    // Look for the "Analyze" button link
    const link = Array.from(document.querySelectorAll('a'))
      .find(a => a.href && a.href.includes('analyze?lines='));
    
    if (link) {
      return link as HTMLAnchorElement;
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  
  return null;
}
