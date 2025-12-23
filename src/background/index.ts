/**
 * Background Service Worker (Manifest V3)
 * Orchestrates the enrichment pipeline with Lichess stats
 * 
 * Architecture:
 * - NO global variables for state (ephemeral worker)
 * - Use chrome.storage.local for persistence
 * - Content script drives extraction via API
 * - Throttle Lichess API calls (1 req/sec max)
 */

import { Chess } from 'chess.js';
import type {
  ExtractedLine,
  RawExtractedLine,
  LichessStats,
  LichessSettings,
  Message,
  StatusResponse,
  CrawlCompletePayload,
  StudyExtractedPayload,
  LineEnrichedPayload,
  DeleteCoursePayload
} from '../types';

console.log('🔧 Background service worker initialized');

// Storage keys
const STORAGE_KEYS = {
  STATE: 'extension_state',
  LINES: 'extracted_lines',
  RAW_LINES: 'raw_lines',
  LICHESS_CACHE: 'lichess_cache',
  LICHESS_SETTINGS: 'lichess_settings'
};

// Default Lichess settings
const DEFAULT_LICHESS_SETTINGS: LichessSettings = {
  speeds: ['blitz', 'rapid', 'classical'],
  ratings: [1600, 1800, 2000, 2200, 2500]
};

// Lichess API Configuration
const LICHESS_API_BASE = 'https://explorer.lichess.ovh';

// Batch processing configuration
const BATCH_SIZE = 3; // Process 3 requests concurrently
const BATCH_DELAY_MS = 2000; // 2 seconds between batches (~1.5 req/sec effective rate)

// Enrichment Queue State
interface QueueItem {
  courseName: string;
  raw: RawExtractedLine;
  fen: string;
}

let enrichmentQueue: QueueItem[] = [];
let isProcessingQueue = false;

// In-flight request deduplication
// Maps FEN -> Promise for requests currently being fetched
const activeFetches = new Map<string, Promise<LichessStats | undefined>>();

/**
 * Initialize state on installation
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('🎉 Extension installed/updated');
  initializeState();
});

/**
 * Message handler - routes messages from popup and content script
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

    case 'STUDY_EXTRACTED':
      handleStudyExtracted(message.payload as StudyExtractedPayload)
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error handling study extracted:', error);
          sendResponse({ error: error.message });
        });
      return true;

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

    case 'UPDATE_SETTINGS':
      handleUpdateSettings(message.payload as LichessSettings)
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error updating settings:', error);
          sendResponse({ error: error.message });
        });
      return true;

    case 'REFRESH_STATS':
      handleRefreshStats()
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error refreshing stats:', error);
          sendResponse({ error: error.message });
        });
      return true;

    case 'CLEAR_DATA':
      handleClearData()
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error clearing data:', error);
          sendResponse({ error: error.message });
        });
      return true;

    case 'DELETE_COURSE':
      handleDeleteCourse(message.payload)
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error deleting course:', error);
          sendResponse({ error: error.message });
        });
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
    lineCount: 0,
    queueLength: 0
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: state });
  
  // Initialize default Lichess settings if not present
  const result = await chrome.storage.local.get(STORAGE_KEYS.LICHESS_SETTINGS);
  if (!result[STORAGE_KEYS.LICHESS_SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.LICHESS_SETTINGS]: DEFAULT_LICHESS_SETTINGS });
  }
}

/**
 * Get current status
 */
async function getStatus(): Promise<StatusResponse> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.STATE);
  const defaultState: StatusResponse = { state: 'idle', lineCount: 0, queueLength: 0 };
  const currentState = result[STORAGE_KEYS.STATE] || defaultState;
  
  // Update with live queue length
  currentState.queueLength = enrichmentQueue.length;
  
  return currentState;
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
 * New flow: Query active tab -> Send SCAN_PAGE to content script
 */
async function handleStartCrawl(): Promise<{ status: string }> {
  console.log('🚀 Starting crawl...');

  // Reset queue and state
  enrichmentQueue = [];
  isProcessingQueue = false;
  
  // Clear RAW_LINES only (keep LINES for persistence across scans)
  await chrome.storage.local.set({ 
    [STORAGE_KEYS.RAW_LINES]: []
  });
  
  // Get current line count from existing data
  const result = await chrome.storage.local.get(STORAGE_KEYS.LINES);
  const existingLines: ExtractedLine[] = result[STORAGE_KEYS.LINES] || [];
  const startingLineCount = existingLines.length;
  
  // Update state to scanning
  await updateState({ state: 'crawling', lineCount: startingLineCount, queueLength: 0 });

  try {
    // Step 1: Get the active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!activeTab || !activeTab.id) {
      throw new Error('No active tab found');
    }

    if (!activeTab.url?.includes('chessly.com')) {
      throw new Error('Please navigate to a Chessly repertoire page first');
    }

    console.log('📍 Active tab:', activeTab.url);

    // Step 2: Send SCAN_PAGE message to content script
    console.log('📨 Sending SCAN_PAGE to content script...');
    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'SCAN_PAGE' });

    if (!response.success) {
      throw new Error(response.error || 'Scan failed');
    }

    console.log('✅ Scan initiated successfully');
    return { status: 'scan_started' };

  } catch (error) {
    console.error('❌ Failed to start crawl:', error);
    await updateState({ 
      state: 'error', 
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

// Worker Tab functions removed - content script now handles extraction via API

/**
 * Handle study extraction - streaming per-study results
 * Immediately queue lines for enrichment
 */
async function handleStudyExtracted(payload: StudyExtractedPayload): Promise<{ status: string }> {
  console.log(`📦 Study extracted: ${payload.lines.length} lines from course "${payload.courseName}"`);

  // Update state to enriching (if not already)
  const currentState = await getStatus();
  if (currentState.state === 'crawling') {
    await updateState({ state: 'enriching' });
  }

  // Process each line immediately
  for (const raw of payload.lines) {
    try {
      // Parse moves and generate FEN
      const moves = raw['Move Order'].split(' ').filter(m => m.trim().length > 0);
      const fen = generateFEN(moves);

      // Check cache first
      const cachedStats = await getCachedLichessStats(fen);
      
      if (cachedStats) {
        // Cache hit! Broadcast enriched line immediately
        const enriched: ExtractedLine = {
          opening: payload.courseName,
          chapter: raw.Chapter,
          study: raw.Study,
          variation: raw.Variation,
          moves,
          fen,
          stats: cachedStats
        };

        await saveEnrichedLine(enriched);
        broadcastLineEnriched(enriched);
      } else {
        // Cache miss - add to enrichment queue
        enrichmentQueue.push({
          courseName: payload.courseName,
          raw,
          fen
        });
      }

    } catch (error) {
      console.warn(`⚠️ Failed to process line:`, error);
    }
  }

  // Start queue processing if not already running
  if (!isProcessingQueue && enrichmentQueue.length > 0) {
    processQueue();
  }

  return { status: 'queued' };
}

/**
 * Handle crawl completion - queue is still processing
 */
async function handleCrawlComplete(_payload: CrawlCompletePayload): Promise<{ status: string }> {
  console.log(`✅ Crawl complete! Queue length: ${enrichmentQueue.length}`);

  // If queue is empty, we're done
  if (enrichmentQueue.length === 0 && !isProcessingQueue) {
    await updateState({ state: 'complete' });
  }

  return { status: 'acknowledged' };
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
 * Queue processor - runs continuously while queue has items
 * Processes items in batches of 3 concurrently with 2s delays between batches
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue) {
    console.log('⚠️ Queue processor already running');
    return;
  }

  isProcessingQueue = true;
  console.log('🔄 Starting burst queue processor...');

  while (enrichmentQueue.length > 0) {
    // Extract batch of items to process
    const batch = enrichmentQueue.splice(0, BATCH_SIZE);
    
    if (batch.length === 0) break;

    console.log(`⚡ Processing batch of ${batch.length} items (${enrichmentQueue.length} remaining)...`);

    // Measure batch processing time
    const batchStartTime = Date.now();

    try {
      // Process batch items concurrently
      await Promise.all(batch.map(async (item) => {
        try {
          // Get Lichess stats (with deduplication)
          const stats = await getLichessStats(item.fen);

          // Cache the result
          await cacheLichessStats(item.fen, stats);

          // Build enriched line
          const moves = item.raw['Move Order'].split(' ').filter(m => m.trim().length > 0);
          const enriched: ExtractedLine = {
            opening: item.courseName,
            chapter: item.raw.Chapter,
            study: item.raw.Study,
            variation: item.raw.Variation,
            moves,
            fen: item.fen,
            stats
          };

          // Save and broadcast
          await saveEnrichedLine(enriched);
          broadcastLineEnriched(enriched);

          console.log(`✅ Enriched: ${item.raw.Chapter} - ${item.raw.Study}`);

        } catch (error) {
          // Check if it's a rate limit error
          if (error instanceof Error && error.message === 'RATE_LIMIT') {
            // Re-throw to be caught by outer catch
            throw error;
          }
          
          console.warn(`⚠️ Failed to enrich line:`, error);
          
          // Save line without stats
          const moves = item.raw['Move Order'].split(' ').filter(m => m.trim().length > 0);
          const enriched: ExtractedLine = {
            opening: item.courseName,
            chapter: item.raw.Chapter,
            study: item.raw.Study,
            variation: item.raw.Variation,
            moves,
            fen: item.fen,
            stats: undefined
          };

          await saveEnrichedLine(enriched);
          broadcastLineEnriched(enriched);
        }
      }));

      // Update queue length in state
      await updateState({ queueLength: enrichmentQueue.length });

      // Calculate remaining time in batch window
      const batchElapsedTime = Date.now() - batchStartTime;
      const remainingDelay = Math.max(0, BATCH_DELAY_MS - batchElapsedTime);

      // Wait for the rest of the batch delay if needed
      if (remainingDelay > 0 && enrichmentQueue.length > 0) {
        console.log(`⏳ Waiting ${remainingDelay}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, remainingDelay));
      }

    } catch (error) {
      // Handle rate limit errors
      if (error instanceof Error && error.message === 'RATE_LIMIT') {
        console.warn('⚠️ Rate limit hit! Putting batch back in queue and waiting 60s...');
        
        // Put batch items back at the front of the queue
        enrichmentQueue.unshift(...batch);
        
        // Wait 60 seconds before retrying
        await new Promise(resolve => setTimeout(resolve, 60000));
        
        // Continue to next iteration
        continue;
      }
      
      // For other errors, log and continue
      console.error('❌ Batch processing error:', error);
    }
  }

  isProcessingQueue = false;
  console.log('🎉 Queue processing complete!');
  
  // Mark as complete
  await updateState({ state: 'complete', queueLength: 0 });
  chrome.runtime.sendMessage({ type: 'ENRICH_COMPLETE' });
}

/**
 * Save an enriched line to storage with deduplication
 * Unique key: opening + chapter + study + variation
 */
async function saveEnrichedLine(line: ExtractedLine): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LINES);
  const lines: ExtractedLine[] = result[STORAGE_KEYS.LINES] || [];
  
  // Check if line already exists
  const existingIndex = lines.findIndex(existing => 
    existing.opening === line.opening &&
    existing.chapter === line.chapter &&
    existing.study === line.study &&
    existing.variation === line.variation
  );
  
  if (existingIndex !== -1) {
    // Update existing line (overwrite)
    console.log(`🔄 Updating existing line: ${line.opening} - ${line.chapter} - ${line.study} - ${line.variation}`);
    lines[existingIndex] = line;
  } else {
    // Add new line
    console.log(`➕ Adding new line: ${line.opening} - ${line.chapter} - ${line.study} - ${line.variation}`);
    lines.push(line);
  }
  
  await chrome.storage.local.set({ [STORAGE_KEYS.LINES]: lines });
  
  // Update line count
  await updateState({ lineCount: lines.length });
}

/**
 * Broadcast enriched line to dashboard/popup
 */
function broadcastLineEnriched(line: ExtractedLine): void {
  chrome.runtime.sendMessage({
    type: 'LINE_ENRICHED',
    payload: { line } as LineEnrichedPayload
  });
}

/**
 * Get cached Lichess stats
 */
async function getCachedLichessStats(fen: string): Promise<LichessStats | undefined> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LICHESS_CACHE);
  const cache: Record<string, LichessStats> = result[STORAGE_KEYS.LICHESS_CACHE] || {};
  return cache[fen];
}

/**
 * Cache Lichess stats
 */
async function cacheLichessStats(fen: string, stats: LichessStats | undefined): Promise<void> {
  if (!stats) return;
  
  const result = await chrome.storage.local.get(STORAGE_KEYS.LICHESS_CACHE);
  const cache: Record<string, LichessStats> = result[STORAGE_KEYS.LICHESS_CACHE] || {};
  cache[fen] = stats;
  await chrome.storage.local.set({ [STORAGE_KEYS.LICHESS_CACHE]: cache });
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
 * Get current Lichess settings
 */
async function getLichessSettings(): Promise<LichessSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LICHESS_SETTINGS);
  return result[STORAGE_KEYS.LICHESS_SETTINGS] || DEFAULT_LICHESS_SETTINGS;
}

/**
 * Get Lichess statistics for a position with in-flight deduplication
 * Uses stored settings for ratings and speeds filters
 * Multiple calls for the same FEN will share the same promise
 */
async function getLichessStats(fen: string): Promise<LichessStats | undefined> {
  // Check if we're already fetching this FEN
  const existingFetch = activeFetches.get(fen);
  if (existingFetch) {
    console.log(`🔄 Deduplicating request for FEN: ${fen.substring(0, 30)}...`);
    return existingFetch;
  }

  // Create new fetch promise
  const fetchPromise = (async () => {
    try {
      // Get current settings
      const settings = await getLichessSettings();
      
      // Build query string dynamically from settings
      const ratingsParam = settings.ratings.join(',');
      const speedsParam = settings.speeds.join(',');
      const url = `${LICHESS_API_BASE}/lichess?fen=${encodeURIComponent(fen)}&ratings=${ratingsParam}&speeds=${speedsParam}`;
      
      const response = await fetch(url);
      
      if (response.status === 429) {
        // Rate limit hit - throw specific error
        throw new Error('RATE_LIMIT');
      }
      
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
      // Re-throw rate limit errors so queue processor can handle them
      if (error instanceof Error && error.message === 'RATE_LIMIT') {
        throw error;
      }
      
      console.warn('⚠️ Failed to fetch Lichess stats:', error);
      return undefined;
    }
  })();

  // Store the promise in activeFetches
  activeFetches.set(fen, fetchPromise);

  // Remove from activeFetches when done (success or failure)
  fetchPromise.finally(() => {
    activeFetches.delete(fen);
  });

  return fetchPromise;
}

/**
 * Handle UPDATE_SETTINGS message from dashboard
 */
async function handleUpdateSettings(settings: LichessSettings): Promise<{ status: string }> {
  console.log('⚙️ Updating Lichess settings:', settings);
  
  // Validate settings
  if (!settings.speeds || settings.speeds.length === 0) {
    throw new Error('At least one speed must be selected');
  }
  
  if (!settings.ratings || settings.ratings.length === 0) {
    throw new Error('At least one rating must be selected');
  }
  
  // Save settings
  await chrome.storage.local.set({ [STORAGE_KEYS.LICHESS_SETTINGS]: settings });
  
  console.log('✅ Settings updated successfully');
  return { status: 'updated' };
}

/**
 * Handle REFRESH_STATS message - re-enrich all lines with new settings
 */
async function handleRefreshStats(): Promise<{ status: string }> {
  console.log('🔄 Refreshing stats with new settings...');
  
  // Clear the enrichment queue
  enrichmentQueue = [];
  
  // Get all extracted lines
  const result = await chrome.storage.local.get(STORAGE_KEYS.LINES);
  const lines: ExtractedLine[] = result[STORAGE_KEYS.LINES] || [];
  
  if (lines.length === 0) {
    console.log('⚠️ No lines to refresh');
    return { status: 'no_lines' };
  }
  
  console.log(`📦 Re-queuing ${lines.length} lines for enrichment...`);
  
  // Clear the Lichess cache to force fresh API calls
  await chrome.storage.local.set({ [STORAGE_KEYS.LICHESS_CACHE]: {} });
  
  // Clear existing lines
  await chrome.storage.local.set({ [STORAGE_KEYS.LINES]: [] });
  
  // Update state
  await updateState({ state: 'enriching', lineCount: 0, queueLength: lines.length });
  
  // Re-add all lines to enrichment queue
  for (const line of lines) {
    enrichmentQueue.push({
      courseName: line.opening,
      raw: {
        Chapter: line.chapter,
        Study: line.study,
        Variation: line.variation,
        'Move Order': line.moves.join(' ')
      },
      fen: line.fen
    });
  }
  
  // Start processing queue
  if (!isProcessingQueue) {
    processQueue();
  }
  
  console.log('✅ Stats refresh initiated');
  return { status: 'refreshing' };
}

/**
 * Handle CLEAR_DATA message - clear all stored data
 */
async function handleClearData(): Promise<{ status: string }> {
  console.log('🗑️ Clearing all data...');
  
  // Clear the enrichment queue
  enrichmentQueue = [];
  isProcessingQueue = false;
  
  // Clear all storage
  await chrome.storage.local.set({ 
    [STORAGE_KEYS.LINES]: [],
    [STORAGE_KEYS.RAW_LINES]: [],
    [STORAGE_KEYS.LICHESS_CACHE]: {}
  });
  
  // Reset state to idle
  await updateState({ 
    state: 'idle', 
    lineCount: 0, 
    queueLength: 0 
  });
  
  console.log('✅ All data cleared successfully');
  return { status: 'cleared' };
}

/**
 * Handle DELETE_COURSE message - delete a specific course/opening
 */
async function handleDeleteCourse(payload: DeleteCoursePayload): Promise<{ status: string, lineCount: number, queueLength: number }> {
  const { courseName } = payload;
  console.log(`🗑️ Deleting course: ${courseName}`);
  
  // Step 1: Filter extracted lines - remove all lines for this course
  const result = await chrome.storage.local.get(STORAGE_KEYS.LINES);
  const lines: ExtractedLine[] = result[STORAGE_KEYS.LINES] || [];
  
  const filteredLines = lines.filter(line => line.opening !== courseName);
  const deletedCount = lines.length - filteredLines.length;
  
  console.log(`📊 Deleting ${deletedCount} lines from storage`);
  
  await chrome.storage.local.set({ [STORAGE_KEYS.LINES]: filteredLines });
  
  // Step 2: Filter enrichment queue - remove pending items for this course
  const originalQueueLength = enrichmentQueue.length;
  enrichmentQueue = enrichmentQueue.filter(item => item.courseName !== courseName);
  const queueDeletedCount = originalQueueLength - enrichmentQueue.length;
  
  console.log(`📊 Removed ${queueDeletedCount} items from enrichment queue`);
  
  // Step 3: Update state
  await updateState({ 
    lineCount: filteredLines.length,
    queueLength: enrichmentQueue.length
  });
  
  console.log(`✅ Course "${courseName}" deleted successfully`);
  return { 
    status: 'deleted',
    lineCount: filteredLines.length,
    queueLength: enrichmentQueue.length
  };
}

// Worker Tab logic removed - content script now handles extraction via API directly
