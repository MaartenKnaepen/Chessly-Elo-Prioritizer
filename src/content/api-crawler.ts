/**
 * API Crawler Service
 * Fetches study data directly from Chessly API and reconstructs chess lines
 * Uses graph traversal with cycle detection to handle complex move trees
 */

import type { RawExtractedLine } from '../types';

interface ApiMove {
  san: string;      // "e4"
  nextFen: string;  // Pointer to next key in the graph
  fen: string;      // Current FEN (redundant but present)
}

type StudyApiResponse = Record<string, ApiMove[]>;

/**
 * Extract UUID from Chessly study URL
 * Example: https://chessly.com/.../studies/abc-123-def -> abc-123-def
 */
function extractUuidFromUrl(url: string): string | null {
  const match = url.match(/\/studies\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch study data from Chessly API
 */
export async function fetchStudyData(studyUrl: string): Promise<RawExtractedLine[]> {
  const uuid = extractUuidFromUrl(studyUrl);
  
  if (!uuid) {
    console.error('❌ Failed to extract UUID from URL:', studyUrl);
    return [];
  }
  
  const apiUrl = `https://cag.chessly.com/beta/openings/courses/studies/${uuid}/moves`;
  
  try {
    const response = await fetch(apiUrl, {
      credentials: 'include', // Critical: Include cookies for authentication
      headers: {
        'Accept': 'application/json',
      }
    });
    
    if (!response.ok) {
      console.error(`❌ API request failed (${response.status}):`, apiUrl);
      return [];
    }
    
    const data: StudyApiResponse = await response.json();
    
    if (typeof data !== 'object' || data === null) {
      console.error('❌ Invalid API response format:', data);
      return [];
    }
    
    // Parse the move graph into linear variations
    return parseMovesGraph(data);
    
  } catch (error) {
    console.error('❌ API fetch error:', error);
    return [];
  }
}

/**
 * Parse the move graph into linear variations
 * Uses DFS with cycle detection and move deduplication
 */
function parseMovesGraph(graph: Record<string, ApiMove[]>): RawExtractedLine[] {
  const lines: RawExtractedLine[] = [];
  let variationCounter = 1;
  
  // Standard chess starting position FEN
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  
  // Track which FENs we've already visited to prevent infinite loops
  const visitedFens = new Set<string>();
  
  /**
   * Recursive DFS traversal
   * @param currentFen - Current position FEN to look up in graph
   * @param currentPath - Accumulated move list (SAN notation)
   * @param depth - Current depth in the tree (for debugging)
   */
  function traverse(currentFen: string, currentPath: string[], depth: number = 0) {
    // Check for cycles
    if (visitedFens.has(currentFen)) {
      console.warn(`⚠️ Cycle detected at FEN: ${currentFen.substring(0, 20)}...`);
      
      // Save the line up to this point if we have moves
      if (currentPath.length > 0) {
        lines.push({
          Chapter: '', // Will be filled in by content script
          Study: '',   // Will be filled in by content script
          Variation: `Var ${variationCounter++}`,
          'Move Order': currentPath.join(' ')
        });
      }
      
      return;
    }
    
    // Mark this FEN as visited
    visitedFens.add(currentFen);
    
    // Get moves available from this position
    const moves = graph[currentFen];
    
    // If no moves available, this is a leaf node
    if (!moves || moves.length === 0) {
      // Save the line if we have moves
      if (currentPath.length > 0) {
        lines.push({
          Chapter: '', // Will be filled in by content script
          Study: '',   // Will be filled in by content script
          Variation: `Var ${variationCounter++}`,
          'Move Order': currentPath.join(' ')
        });
      }
      
      visitedFens.delete(currentFen);
      return;
    }
    
    // Deduplicate moves at this node (same move can appear multiple times)
    const uniqueMoves = new Map<string, ApiMove>();
    
    for (const moveObj of moves) {
      if (!uniqueMoves.has(moveObj.san)) {
        uniqueMoves.set(moveObj.san, moveObj);
      }
    }
    
    // Process each unique move
    for (const [moveSan, moveObj] of uniqueMoves) {
      const newPath = [...currentPath, moveSan];
      
      // Recurse into the next position
      traverse(moveObj.nextFen, newPath, depth + 1);
    }
    
    // Unmark FEN after exploring this branch (backtrack)
    visitedFens.delete(currentFen);
  }
  
  // Find starting position
  if (graph[START_FEN]) {
    // Standard case: start from standard starting position
    traverse(START_FEN, [], 0);
  } else {
    // Fallback: try to find a starting position by looking for the shortest FEN
    // (starting position has fewer piece movements)
    console.warn('⚠️ Standard starting FEN not found, searching for alternative start...');
    const fens = Object.keys(graph);
    
    if (fens.length > 0) {
      // Sort by FEN length (heuristic: starting positions tend to be shorter)
      fens.sort((a, b) => a.length - b.length);
      const startFen = fens[0];
      console.log(`📍 Using alternative starting FEN: ${startFen.substring(0, 30)}...`);
      traverse(startFen, [], 0);
    } else {
      console.error('❌ No positions found in graph');
    }
  }
  
  return lines;
}

/**
 * Test function for debugging
 */
export async function testApiCrawler(studyUrl: string): Promise<void> {
  console.log('🧪 Testing API Crawler...');
  console.log('URL:', studyUrl);
  
  const lines = await fetchStudyData(studyUrl);
  
  console.log(`✅ Extracted ${lines.length} variations`);
  console.log('Sample lines:', lines.slice(0, 3));
}
