/**
 * Extractor Content Script
 * Runs on Chessly study pages in a Worker Tab
 * Extracts move data from the "Analyze" button when commanded by Background
 */

import type { Message, StudyExtractedPayload, RawExtractedLine } from '../types';

console.log('🔧 Extractor script loaded');

// Configuration
const POLL_TIMEOUT_MS = 15000; // Give up after 15 seconds (allows time for slow CPU/network)
const POLL_INTERVAL_MS = 100; // Check every 100ms

// REVERSE HANDSHAKE: Immediately signal to Background that we're ready
// This eliminates race conditions where Background sends EXTRACT_MOVES before the script is ready
chrome.runtime.sendMessage({ type: 'EXTRACTOR_READY' }).catch(err => {
  console.warn('⚠️ Failed to send EXTRACTOR_READY (background may not be listening yet):', err);
});

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
  
  // TRY METHOD 1: Extract from __NEXT_DATA__ JSON (most reliable)
  const jsonLines = await extractFromNextData();
  
  if (jsonLines && jsonLines.length > 0) {
    console.log(`✅ Found ${jsonLines.length} lines in JSON data`);
    
    // Build raw extracted lines
    const rawLines: RawExtractedLine[] = jsonLines.map((line, idx) => ({
      Chapter: chapter,
      Study: study,
      Variation: `Var ${idx + 1}`,
      'Move Order': line
    }));
    
    // Send results to Background
    chrome.runtime.sendMessage({
      type: 'STUDY_EXTRACTED',
      payload: {
        courseName,
        lines: rawLines
      } as StudyExtractedPayload
    });
    return;
  }
  
  console.log('⚠️ JSON extraction failed, falling back to DOM method...');
  
  // FALLBACK METHOD 2: Wait for the "Analyze" button to appear
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
 * Extract moves from __NEXT_DATA__ JSON (most reliable method)
 * Next.js stores the entire React state in a script tag
 */
async function extractFromNextData(): Promise<string[] | null> {
  try {
    // Find the __NEXT_DATA__ script tag
    const scriptTag = document.getElementById('__NEXT_DATA__');
    
    if (!scriptTag || !scriptTag.textContent) {
      console.log('⚠️ __NEXT_DATA__ script tag not found');
      return null;
    }
    
    // Parse the JSON
    const data = JSON.parse(scriptTag.textContent);
    console.log('📦 Found __NEXT_DATA__, searching for moves...');
    
    // Search recursively for keys matching "lines", "moves", or "pgn"
    const foundLines = findKeys(data, ['lines', 'moves', 'pgn']);
    
    if (foundLines.length === 0) {
      console.log('⚠️ No lines/moves/pgn found in JSON structure');
      console.log('📊 JSON structure sample:', JSON.stringify(data, null, 2).substring(0, 500));
      return null;
    }
    
    console.log('✅ Found moves in JSON:', foundLines);
    return foundLines;
    
  } catch (error) {
    console.warn('⚠️ Failed to extract from __NEXT_DATA__:', error);
    return null;
  }
}

/**
 * Recursively search for keys in an object
 * Returns array of move strings found
 */
function findKeys(obj: any, keyNames: string[]): string[] {
  const results: string[] = [];
  
  function search(current: any, path: string = ''): void {
    if (!current || typeof current !== 'object') {
      return;
    }
    
    // Check if current object has any of the target keys
    for (const keyName of keyNames) {
      if (keyName in current) {
        const value = current[keyName];
        console.log(`🔍 Found key "${keyName}" at path: ${path}`);
        
        // Handle different data types
        if (Array.isArray(value)) {
          // If it's an array of strings, add them
          for (const item of value) {
            if (typeof item === 'string') {
              results.push(item);
            } else if (typeof item === 'object' && item !== null) {
              // If array contains objects, search recursively
              search(item, `${path}.${keyName}[]`);
            }
          }
        } else if (typeof value === 'string') {
          results.push(value);
        } else if (typeof value === 'object' && value !== null) {
          // If it's an object, search recursively
          search(value, `${path}.${keyName}`);
        }
      }
    }
    
    // Recursively search all properties
    for (const key in current) {
      if (current.hasOwnProperty(key)) {
        search(current[key], path ? `${path}.${key}` : key);
      }
    }
  }
  
  search(obj);
  return results;
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
