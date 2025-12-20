/**
 * Background Service Worker (Manifest V3)
 * Orchestrates the crawl pipeline and enriches data with Lichess stats
 * 
 * Architecture:
 * - NO global variables for state (ephemeral worker)
 * - Use chrome.storage.local for persistence
 * - Coordinate offscreen document for crawling
 * - Throttle Lichess API calls (1 req/sec max)
 */

import { Chess } from 'chess.js';
import type {
  ExtractedLine,
  RawExtractedLine,
  LichessStats,
  Message,
  StatusResponse,
  CrawlCompletePayload,
  EnrichProgressPayload
} from '../types';

console.log('🔧 Background service worker initialized');

// Storage keys
const STORAGE_KEYS = {
  STATE: 'extension_state',
  LINES: 'extracted_lines',
  RAW_LINES: 'raw_lines'
};

// Lichess API Configuration
const LICHESS_API_BASE = 'https://explorer.lichess.ovh';
const LICHESS_RATE_LIMIT_MS = 1000; // 1 request per second
let lastLichessRequest = 0;

/**
 * Initialize state on installation
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('🎉 Extension installed/updated');
  initializeState();
});

/**
 * Message handler - routes messages from popup and offscreen
 */
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  console.log('📨 Received message:', message.type);

  switch (message.type) {
    case 'START_CRAWL':
      handleStartCrawl().then(sendResponse).catch(error => {
        console.error('❌ Error starting crawl:', error);
        sendResponse({ error: error.message });
      });
      return true; // Keep channel open for async response

    case 'CRAWL_COMPLETE':
      handleCrawlComplete(message.payload as CrawlCompletePayload)
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error handling crawl complete:', error);
          sendResponse({ error: error.message });
        });
      return true;

    case 'CRAWL_ERROR':
      handleCrawlError(message.payload).then(sendResponse);
      return true;

    case 'GET_STATUS':
      getStatus().then(sendResponse);
      return true;

    default:
      console.warn('⚠️ Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
});

/**
 * Initialize default state
 */
async function initializeState(): Promise<void> {
  const state: StatusResponse = {
    state: 'idle',
    lineCount: 0
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: state });
}

/**
 * Get current status
 */
async function getStatus(): Promise<StatusResponse> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.STATE);
  return result[STORAGE_KEYS.STATE] || { state: 'idle', lineCount: 0 };
}

/**
 * Update state in storage
 */
async function updateState(updates: Partial<StatusResponse>): Promise<void> {
  const current = await getStatus();
  const newState = { ...current, ...updates };
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: newState });
}

/**
 * Start the crawl process
 */
async function handleStartCrawl(): Promise<{ status: string }> {
  console.log('🚀 Starting crawl...');

  // Update state
  await updateState({ state: 'crawling', lineCount: 0 });

  // Ensure offscreen document exists
  await setupOffscreenDocument();

  // Send message to offscreen to start crawling
  chrome.runtime.sendMessage({ type: 'START_CRAWL' });

  return { status: 'crawl_started' };
}

/**
 * Handle crawl completion - start enrichment
 */
async function handleCrawlComplete(payload: CrawlCompletePayload): Promise<{ status: string }> {
  console.log(`✅ Crawl complete! Received ${payload.count} lines`);

  // Save raw lines
  await chrome.storage.local.set({ [STORAGE_KEYS.RAW_LINES]: payload.lines });

  // Update state
  await updateState({
    state: 'enriching',
    lineCount: payload.count,
    progress: { current: 0, total: payload.count }
  });

  // Start enrichment process
  enrichLines(payload.lines).catch(error => {
    console.error('❌ Enrichment failed:', error);
    updateState({ state: 'error', error: error.message });
  });

  return { status: 'enrichment_started' };
}

/**
 * Handle crawl error
 */
async function handleCrawlError(payload: any): Promise<{ status: string }> {
  console.error('❌ Crawl error:', payload);
  await updateState({ state: 'error', error: payload.error });
  return { status: 'error_recorded' };
}

/**
 * Enrich raw lines with FEN and Lichess stats
 */
async function enrichLines(rawLines: RawExtractedLine[]): Promise<void> {
  console.log('🎨 Starting enrichment...');

  const enrichedLines: ExtractedLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    
    try {
      // Parse moves and generate FEN
      const moves = raw['Move Order'].split(' ').filter(m => m.trim().length > 0);
      const fen = generateFEN(moves);

      // Get Lichess stats (with throttling)
      const stats = await getLichessStats(fen);

      const enriched: ExtractedLine = {
        opening: raw.Chapter, // Using Chapter as opening name
        chapter: raw.Chapter,
        study: raw.Study,
        variation: raw.Variation,
        moves,
        fen,
        stats
      };

      enrichedLines.push(enriched);

      // Update progress
      await updateState({
        state: 'enriching',
        lineCount: rawLines.length,
        progress: { current: i + 1, total: rawLines.length }
      });

      // Send progress message to popup
      chrome.runtime.sendMessage({
        type: 'ENRICH_PROGRESS',
        payload: {
          current: i + 1,
          total: rawLines.length,
          currentLine: `${raw.Chapter} - ${raw.Study}`
        } as EnrichProgressPayload
      });

    } catch (error) {
      console.warn(`⚠️ Failed to enrich line ${i + 1}:`, error);
      // Add line without stats
      enrichedLines.push({
        opening: raw.Chapter,
        chapter: raw.Chapter,
        study: raw.Study,
        variation: raw.Variation,
        moves: raw['Move Order'].split(' ').filter(m => m.trim().length > 0),
        fen: 'error',
        stats: undefined
      });
    }
  }

  // Save enriched lines
  await chrome.storage.local.set({ [STORAGE_KEYS.LINES]: enrichedLines });

  // Update state to complete
  await updateState({
    state: 'complete',
    lineCount: enrichedLines.length,
    progress: undefined
  });

  console.log('🎉 Enrichment complete!');
  chrome.runtime.sendMessage({ type: 'ENRICH_COMPLETE' });
}

/**
 * Generate FEN from move sequence using chess.js
 */
function generateFEN(moves: string[]): string {
  const chess = new Chess();
  
  for (const move of moves) {
    try {
      chess.move(move);
    } catch (error) {
      console.warn(`⚠️ Invalid move: ${move}`, error);
      throw new Error(`Invalid move: ${move}`);
    }
  }

  return chess.fen();
}

/**
 * Get Lichess statistics for a position (with throttling)
 */
async function getLichessStats(fen: string): Promise<LichessStats | undefined> {
  // Throttle requests
  const now = Date.now();
  const timeSinceLastRequest = now - lastLichessRequest;
  if (timeSinceLastRequest < LICHESS_RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, LICHESS_RATE_LIMIT_MS - timeSinceLastRequest));
  }
  lastLichessRequest = Date.now();

  try {
    const url = `${LICHESS_API_BASE}/lichess?fen=${encodeURIComponent(fen)}&ratings=2000,2200,2500&speeds=blitz,rapid,classical`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      console.warn(`⚠️ Lichess API error: ${response.status}`);
      return undefined;
    }

    const data = await response.json();
    
    // Extract stats
    const white = data.white || 0;
    const black = data.black || 0;
    const draws = data.draws || 0;
    const total = white + black + draws;

    return {
      white,
      black,
      draws,
      total
    };

  } catch (error) {
    console.warn('⚠️ Failed to fetch Lichess stats:', error);
    return undefined;
  }
}

/**
 * Setup offscreen document for crawling
 */
async function setupOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType]
  });

  if (existingContexts.length > 0) {
    console.log('✅ Offscreen document already exists');
    return;
  }

  console.log('📄 Creating offscreen document...');
  
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/index.html',
    reasons: ['DOM_SCRAPING' as chrome.offscreen.Reason],
    justification: 'Parse Chessly study pages to extract chess moves'
  });

  console.log('✅ Offscreen document created');
}
