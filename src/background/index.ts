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
  LichessSettings,
  Message,
  StatusResponse,
  CrawlCompletePayload,
  ScanCompletePayload,
  StudyExtractedPayload,
  LineEnrichedPayload,
  CrawlTask
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
const LICHESS_RATE_LIMIT_MS = 1000; // 1 request per second
let lastLichessRequest = 0;

// Enrichment Queue State
interface QueueItem {
  courseName: string;
  raw: RawExtractedLine;
  fen: string;
}

let enrichmentQueue: QueueItem[] = [];
let isProcessingQueue = false;

// Worker Tab State
let workerTabId: number | null = null;
let taskQueue: CrawlTask[] = [];
let isProcessingTasks = false;
let extractorReadyResolve: (() => void) | null = null;

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
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  console.log('📨 Received message:', message.type);

  switch (message.type) {
    case 'START_CRAWL':
      handleStartCrawl().then(sendResponse).catch(error => {
        console.error('❌ Error starting crawl:', error);
        sendResponse({ error: error.message });
      });
      return true; // Keep channel open for async response

    case 'SCAN_COMPLETE':
      handleScanComplete(message.payload as ScanCompletePayload)
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error handling scan complete:', error);
          sendResponse({ error: error.message });
        });
      return true;

    case 'EXTRACTOR_READY':
      handleExtractorReady(sender.tab?.id)
        .then(sendResponse)
        .catch(error => {
          console.error('❌ Error handling extractor ready:', error);
          sendResponse({ error: error.message });
        });
      return true;

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
  
  // FORCE CLEAR ALL NETWORK RULES (Step 1 of plan)
  // Ensures 100% clean network state - no residual blocking
  console.log('🧹 Background Startup: Ensuring rules are cleared...');
  try {
    console.log('🧹 Force clearing all declarativeNetRequest rules...');
    
    // Clear session rules
    await chrome.declarativeNetRequest.updateSessionRules({ 
      removeRuleIds: [1] 
    });
    
    // Clear dynamic rules (just in case they were persisted)
    await chrome.declarativeNetRequest.updateDynamicRules({ 
      removeRuleIds: [1, 2, 3, 4] 
    });
    
    console.log('✅ All network rules cleared successfully (Rules Nuked)');
  } catch (error) {
    console.warn('⚠️ Failed to clear network rules (may not exist):', error);
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
  
  // Clear previous data
  await chrome.storage.local.set({ 
    [STORAGE_KEYS.LINES]: [],
    [STORAGE_KEYS.RAW_LINES]: []
  });
  
  // Update state to scanning
  await updateState({ state: 'crawling', lineCount: 0, queueLength: 0 });

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

/**
 * Handle scan completion from content script
 * Start the Worker Tab crawler with the collected tasks
 */
async function handleScanComplete(payload: ScanCompletePayload): Promise<{ status: string }> {
  console.log(`✅ Scan complete! Received ${payload.count} tasks`);

  if (payload.count === 0) {
    await updateState({ state: 'error', error: 'No studies found on the page' });
    return { status: 'error' };
  }

  // Update state
  await updateState({ 
    state: 'crawling', 
    lineCount: 0,
    progress: { current: 0, total: payload.count }
  });

  // Initialize task queue
  taskQueue = payload.tasks;
  
  // Start processing tasks
  processTaskQueue();

  return { status: 'crawl_started' };
}

/**
 * Handle EXTRACTOR_READY message from content script
 * This is the reverse handshake - content script signals it's ready
 */
async function handleExtractorReady(tabId: number | undefined): Promise<{ status: string }> {
  console.log(`🤝 Extractor ready signal received from tab ${tabId}`);
  
  // Check if this is from our worker tab
  if (tabId !== workerTabId) {
    console.log('⚠️ Extractor ready from non-worker tab, ignoring');
    return { status: 'ignored' };
  }
  
  // Resolve the promise if we're waiting for extractor
  if (extractorReadyResolve) {
    console.log('✅ Extractor handshake complete, sending EXTRACT_MOVES');
    extractorReadyResolve();
    extractorReadyResolve = null;
  }
  
  return { status: 'acknowledged' };
}

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
 * Processes one item per second to respect Lichess rate limits
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue) {
    console.log('⚠️ Queue processor already running');
    return;
  }

  isProcessingQueue = true;
  console.log('🔄 Starting queue processor...');

  while (enrichmentQueue.length > 0) {
    const item = enrichmentQueue.shift();
    if (!item) break;

    try {
      // Get Lichess stats (with throttling)
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

      console.log(`✅ Enriched: ${item.raw.Chapter} - ${item.raw.Study} (Queue: ${enrichmentQueue.length})`);

    } catch (error) {
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

    // Update queue length in state
    await updateState({ queueLength: enrichmentQueue.length });
  }

  isProcessingQueue = false;
  console.log('🎉 Queue processing complete!');
  
  // Mark as complete
  await updateState({ state: 'complete', queueLength: 0 });
  chrome.runtime.sendMessage({ type: 'ENRICH_COMPLETE' });
}

/**
 * Save an enriched line to storage
 */
async function saveEnrichedLine(line: ExtractedLine): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LINES);
  const lines: ExtractedLine[] = result[STORAGE_KEYS.LINES] || [];
  lines.push(line);
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
 * Get Lichess statistics for a position (with throttling)
 * Uses stored settings for ratings and speeds filters
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
    // Get current settings
    const settings = await getLichessSettings();
    
    // Build query string dynamically from settings
    const ratingsParam = settings.ratings.join(',');
    const speedsParam = settings.speeds.join(',');
    const url = `${LICHESS_API_BASE}/lichess?fen=${encodeURIComponent(fen)}&ratings=${ratingsParam}&speeds=${speedsParam}`;
    
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
 * Enable resource blocking for Worker Tab only (scoped blocking)
 * DISABLED: Prioritizing page stability over performance
 */
// @ts-ignore - Function disabled but kept for future use
async function enableWorkerTabBlocking(tabId: number): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id: 1,
          priority: 1,
          action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
          condition: {
            resourceTypes: [
              'image' as chrome.declarativeNetRequest.ResourceType,
              'media' as chrome.declarativeNetRequest.ResourceType,
              'font' as chrome.declarativeNetRequest.ResourceType
            ],
            tabIds: [tabId]
          }
        }
      ],
      removeRuleIds: []
    });
    console.log(`🚫 Enabled resource blocking for Worker Tab ${tabId}`);
  } catch (error) {
    console.warn('⚠️ Failed to enable resource blocking:', error);
  }
}

/**
 * Disable resource blocking (cleanup)
 * DISABLED: Prioritizing page stability over performance
 */
// @ts-ignore - Function disabled but kept for future use
async function disableWorkerTabBlocking(): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: [1]
    });
    console.log('✅ Disabled resource blocking');
  } catch (error) {
    console.warn('⚠️ Failed to disable resource blocking:', error);
  }
}

/**
 * Process task queue using Worker Tab
 * Creates a pinned background tab that cycles through study URLs
 */
async function processTaskQueue(): Promise<void> {
  if (isProcessingTasks) {
    console.log('⚠️ Task queue processor already running');
    return;
  }

  if (taskQueue.length === 0) {
    console.log('✅ No tasks to process');
    return;
  }

  isProcessingTasks = true;
  console.log(`🔄 Starting Worker Tab processor with ${taskQueue.length} tasks...`);

  try {
    // Step 1: Verify existing Worker Tab or create new one
    if (workerTabId) {
      try {
        // Verify the tab still exists
        await chrome.tabs.get(workerTabId);
        console.log(`✅ Using existing Worker Tab: ${workerTabId}`);
      } catch (error) {
        // Tab doesn't exist anymore (user closed it or extension restarted)
        console.log('⚠️ Worker Tab no longer exists, creating new one...');
        workerTabId = null;
      }
    }
    
    if (!workerTabId) {
      console.log('📄 Creating Worker Tab...');
      const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: true,
        pinned: false
      });
      workerTabId = tab.id!;
      console.log(`✅ Worker Tab created: ${workerTabId}`);
      
      // Resource blocking disabled - priority is page stability
      // await enableWorkerTabBlocking(workerTabId);
    }

    // Step 2: Process each task sequentially
    for (let i = 0; i < taskQueue.length; i++) {
      const task = taskQueue[i];

      console.log(`⏳ [${i + 1}/${taskQueue.length}] Processing: ${task.chapter} - ${task.study}`);

      // Update progress
      await updateState({
        state: 'crawling',
        progress: { current: i + 1, total: taskQueue.length }
      });

      try {
        // Navigate to study URL
        await chrome.tabs.update(workerTabId!, { url: task.url });

        // Wait for EXTRACTOR_READY handshake (with timeout)
        await waitForExtractorReady(workerTabId!, task);

        // Small delay to let the extraction message be sent
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.warn(`⚠️ Failed to process task ${i + 1}:`, error);
        // Continue with next task
      }
    }

    // Step 3: Send completion signal
    console.log('🎉 Task queue processing complete!');
    await handleCrawlComplete({ lines: [], count: 0 });

  } catch (error) {
    console.error('❌ Task queue processing failed:', error);
    await updateState({ state: 'error', error: error instanceof Error ? error.message : 'Unknown error' });
  } finally {
    // Step 4: Cleanup - ALWAYS runs even if there's an error
    isProcessingTasks = false;
    taskQueue = [];
    
    // Close worker tab if it exists
    if (workerTabId) {
      console.log('🧹 Closing Worker Tab...');
      
      try {
        // Resource blocking disabled - no need to clean up
        // await disableWorkerTabBlocking();
        
        // Try to close the tab (might fail if user already closed it)
        await chrome.tabs.remove(workerTabId);
        console.log('✅ Worker Tab closed successfully');
      } catch (error) {
        console.log('⚠️ Worker Tab already closed or inaccessible');
      } finally {
        // ALWAYS reset workerTabId, even if removal fails
        workerTabId = null;
      }
    }
  }
}

/**
 * Wait for extractor ready signal (Reverse Handshake)
 * With fallback timeout for reload if stuck
 */
function waitForExtractorReady(tabId: number, task: CrawlTask): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      extractorReadyResolve = null;
      console.warn('⚠️ Extractor handshake timeout - reloading tab');
      chrome.tabs.reload(tabId).then(() => {
        reject(new Error('Extractor handshake timeout'));
      });
    }, 10000); // 10 second timeout

    // Set up the resolve handler
    extractorReadyResolve = () => {
      clearTimeout(timeout);
      
      // Now send EXTRACT_MOVES command
      chrome.tabs.sendMessage(tabId, {
        type: 'EXTRACT_MOVES',
        payload: {
          courseName: task.courseName,
          chapter: task.chapter,
          study: task.study
        }
      }).then(() => {
        resolve();
      }).catch((error) => {
        console.warn('⚠️ Failed to send EXTRACT_MOVES:', error);
        resolve(); // Continue anyway
      });
    };
  });
}
