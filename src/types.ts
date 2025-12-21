/**
 * Shared type definitions for the Chrome Extension
 * Used across background, offscreen, and popup contexts
 */

export interface ExtractedLine {
  opening: string;    // e.g., "Vienna Gambit"
  chapter: string;    // e.g., "Chapter 1"
  study: string;      // e.g., "Study 2"
  variation: string;  // e.g., "Var 1"
  moves: string[];    // e.g., ["e4", "e5", "Nf3", "Nc6"]
  fen: string;        // Resulting FEN position after all moves
  stats?: LichessStats;
}

export interface LichessStats {
  white: number;      // Number of white wins
  black: number;      // Number of black wins
  draws: number;      // Number of draws
  total?: number;     // Total games (computed)
}

export interface CrawlTask {
  courseName: string;  // The course/opening name (e.g., "Vienna Gambit")
  chapter: string;
  study: string;
  url: string;
}

export interface RawExtractedLine {
  Chapter: string;
  Study: string;
  Variation: string;
  "Move Order": string;  // Space-separated moves
}

// Message Types for chrome.runtime communication
export type MessageType = 
  | 'START_CRAWL'
  | 'SCAN_PAGE'
  | 'SCAN_COMPLETE'
  | 'EXTRACT_MOVES'        // New: Command Worker Tab to extract moves
  | 'CRAWL_PROGRESS'
  | 'CRAWL_COMPLETE'
  | 'CRAWL_ERROR'
  | 'STUDY_EXTRACTED'      // New: Streaming per-study results
  | 'LINE_ENRICHED'        // New: Streaming enriched lines
  | 'ENRICH_START'
  | 'ENRICH_PROGRESS'
  | 'ENRICH_COMPLETE'
  | 'GET_STATUS';

export interface Message {
  type: MessageType;
  payload?: any;
}

export interface ScanCompletePayload {
  tasks: CrawlTask[];
  count: number;
}

export interface StartCrawlPayload {
  tasks: CrawlTask[];
}

export interface CrawlProgressPayload {
  current: number;
  total: number;
  currentTask: string;
}

export interface CrawlCompletePayload {
  lines: RawExtractedLine[];
  count: number;
}

export interface EnrichProgressPayload {
  current: number;
  total: number;
  currentLine: string;
}

export interface StudyExtractedPayload {
  courseName: string;
  lines: RawExtractedLine[];
}

export interface LineEnrichedPayload {
  line: ExtractedLine;
}

export interface StatusResponse {
  state: 'idle' | 'crawling' | 'enriching' | 'complete' | 'error';
  lineCount: number;
  queueLength: number;  // New: Track pending Lichess enrichment requests
  progress?: {
    current: number;
    total: number;
  };
  error?: string;
}
