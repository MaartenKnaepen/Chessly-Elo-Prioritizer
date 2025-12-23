/**
 * API Crawler Service
 * Fetches study data directly from Chessly API and reconstructs chess lines
 * Uses graph traversal with cycle detection to handle complex move trees
 */

import type { RawExtractedLine } from '../types';

interface ApiMove {
  fen: string;
  move: string;
  nextMoves?: ApiMove[];
}

interface StudyApiResponse {
  moves: ApiMove[];
}

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
    
    if (!data.moves || !Array.isArray(data.moves)) {
      console.error('❌ Invalid API response format:', data);
      return [];
    }
    
    // Parse the move graph into linear variations
    return parseMovesGraph(data.moves);
    
  } catch (error) {
    console.error('❌ API fetch error:', error);
    return [];
  }
}

/**
 * Parse the move graph into linear variations
 * Uses DFS with cycle detection and move deduplication
 */
function parseMovesGraph(rootMoves: ApiMove[]): RawExtractedLine[] {
  const lines: RawExtractedLine[] = [];
  let variationCounter = 1;
  
  // Track which FENs we've already visited to prevent infinite loops
  const visitedFens = new Set<string>();
  
  /**
   * Recursive DFS traversal
   * @param moves - Current moves to process
   * @param currentPath - Accumulated move list (SAN notation)
   * @param depth - Current depth in the tree (for debugging)
   */
  function traverse(moves: ApiMove[], currentPath: string[], depth: number = 0) {
    // Deduplicate moves at this node (same move can appear multiple times)
    const uniqueMoves = new Map<string, ApiMove>();
    
    for (const moveObj of moves) {
      if (!uniqueMoves.has(moveObj.move)) {
        uniqueMoves.set(moveObj.move, moveObj);
      }
    }
    
    // Process each unique move
    for (const [moveSan, moveObj] of uniqueMoves) {
      const newPath = [...currentPath, moveSan];
      
      // Check for cycles using FEN
      if (visitedFens.has(moveObj.fen)) {
        // Cycle detected - this is a leaf node for our purposes
        console.warn(`⚠️ Cycle detected at FEN: ${moveObj.fen.substring(0, 20)}...`);
        
        // Save the line up to this point
        lines.push({
          Chapter: '', // Will be filled in by content script
          Study: '',   // Will be filled in by content script
          Variation: `Var ${variationCounter++}`,
          'Move Order': newPath.join(' ')
        });
        
        continue;
      }
      
      // Mark this FEN as visited
      visitedFens.add(moveObj.fen);
      
      // If this move has no children, it's a leaf node - save the line
      if (!moveObj.nextMoves || moveObj.nextMoves.length === 0) {
        lines.push({
          Chapter: '', // Will be filled in by content script
          Study: '',   // Will be filled in by content script
          Variation: `Var ${variationCounter++}`,
          'Move Order': newPath.join(' ')
        });
      } else {
        // Recurse into children
        traverse(moveObj.nextMoves, newPath, depth + 1);
      }
      
      // Unmark FEN after exploring this branch (backtrack)
      visitedFens.delete(moveObj.fen);
    }
  }
  
  // Start traversal from root moves
  traverse(rootMoves, [], 0);
  
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
