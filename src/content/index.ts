/**
 * Content Script - Runs on Chessly pages
 * Handles scanning, API crawling, and streaming results to background
 * This script now drives the entire extraction process
 */

import type { CrawlTask, Message, StudyExtractedPayload } from '../types';
import { fetchStudyData } from './api-crawler';

console.log('🔧 Content script initialized on Chessly page');

// Configuration
const API_CRAWL_DELAY_MS = 200;  // Polite delay between API requests

/**
 * Listen for SCAN_PAGE message from background
 */
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'SCAN_PAGE') {
    console.log('🔍 Received SCAN_PAGE command');
    
    // Start the extraction pipeline (async)
    runExtractionPipeline()
      .then(() => {
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error('❌ Extraction pipeline failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
});

/**
 * Main extraction pipeline
 * Scans page, calls API for each study, and streams results to background
 */
async function runExtractionPipeline(): Promise<void> {
  console.log('🚀 Starting extraction pipeline...');
  
  // Show progress toast
  showToast('Starting extraction...');
  
  // Step 1: Scan page and collect tasks
  const tasks = await scanPage();
  console.log(`✅ Scan complete! Found ${tasks.length} studies`);
  
  if (tasks.length === 0) {
    showToast('No studies found', 'error');
    throw new Error('No studies found on this page');
  }
  
  // Step 2: Process each study via API
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`🔍 Extracting study ${i + 1}/${tasks.length}: ${task.study}`);
    showToast(`Extracting study ${i + 1}/${tasks.length}...`);
    
    try {
      // Fetch data from API
      const rawLines = await fetchStudyData(task.url);
      
      // Fill in Chapter and Study metadata
      const enrichedLines = rawLines.map(line => ({
        ...line,
        Chapter: task.chapter,
        Study: task.study
      }));
      
      console.log(`  ✅ Extracted ${enrichedLines.length} variations`);
      
      // Send STUDY_EXTRACTED message to background for enrichment
      const payload: StudyExtractedPayload = {
        courseName: task.courseName,
        lines: enrichedLines
      };
      
      chrome.runtime.sendMessage({
        type: 'STUDY_EXTRACTED',
        payload
      });
      
      // Polite delay between API requests
      if (i < tasks.length - 1) {
        await sleep(API_CRAWL_DELAY_MS);
      }
      
    } catch (error) {
      console.error(`❌ Failed to extract study ${task.study}:`, error);
      // Continue with next study
    }
  }
  
  // Step 3: Send CRAWL_COMPLETE message
  console.log('✅ All studies extracted!');
  showToast(`Extraction complete! ${tasks.length} studies processed`, 'success');
  
  chrome.runtime.sendMessage({
    type: 'CRAWL_COMPLETE',
    payload: {}
  });
}

/**
 * Main page scanning logic - API-based
 * Fetches course structure directly from Chessly API
 */
async function scanPage(): Promise<CrawlTask[]> {
  console.log('🚀 Starting API scan...');
  showToast('Scanning course structure...', 'info');
  
  const tasks: CrawlTask[] = [];
  
  // Capture the Course Name (usually the main h1 on the page)
  const courseName = extractCourseName();
  console.log(`📖 Course: ${courseName}`);
  
  // Extract courseId from URL
  // Expected URL patterns:
  // - https://chessly.com/courses/{courseId}
  // - https://chessly.com/courses/{courseId}/...
  const urlMatch = window.location.pathname.match(/\/courses\/([^\/]+)/);
  
  if (!urlMatch) {
    throw new Error('Could not extract course ID from URL. Make sure you are on a Chessly course page.');
  }
  
  const courseId = urlMatch[1];
  console.log(`🔑 Course ID: ${courseId}`);
  
  try {
    // Step 1: Fetch all chapters for this course
    const chaptersUrl = `https://cag.chessly.com/beta/openings/courses/${courseId}/chapters`;
    console.log(`📡 Fetching chapters from API: ${chaptersUrl}`);
    
    const chaptersResponse = await fetch(chaptersUrl, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      }
    });
    
    if (!chaptersResponse.ok) {
      throw new Error(`Failed to fetch chapters (${chaptersResponse.status})`);
    }
    
    const chapters = await chaptersResponse.json();
    
    if (!Array.isArray(chapters) || chapters.length === 0) {
      throw new Error('No chapters found in API response');
    }
    
    console.log(`📚 Found ${chapters.length} chapters`);
    
    // Step 2: Fetch studies for all chapters concurrently (Promise.all for speed)
    const chapterStudiesPromises = chapters.map(async (chapter: any) => {
      const chapterId = chapter.id;
      const chapterName = chapter.name || 'Unknown Chapter';
      
      console.log(`  📖 Fetching studies for chapter: ${chapterName}`);
      
      const studiesUrl = `https://cag.chessly.com/beta/openings/courses/chapters/${chapterId}/studies`;
      
      try {
        const studiesResponse = await fetch(studiesUrl, {
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
          }
        });
        
        if (!studiesResponse.ok) {
          console.warn(`  ⚠️ Failed to fetch studies for chapter ${chapterName} (${studiesResponse.status})`);
          return [];
        }
        
        const studies = await studiesResponse.json();
        
        if (!Array.isArray(studies)) {
          console.warn(`  ⚠️ Invalid studies response for chapter ${chapterName}`);
          return [];
        }
        
        console.log(`  ✅ Found ${studies.length} studies in ${chapterName}`);
        
        // Map studies to CrawlTask format
        return studies.map((study: any) => {
          const studyId = study.id;
          const studyName = study.name || 'Unknown Study';
          
          // Construct synthetic URL for api-crawler (needs URL to extract UUID)
          const url = `https://chessly.com/courses/${courseId}/chapters/${chapterId}/studies/${studyId}`;
          
          return {
            courseName,
            chapter: chapterName,
            study: studyName,
            url
          } as CrawlTask;
        });
        
      } catch (error) {
        console.warn(`  ⚠️ Error fetching studies for chapter ${chapterName}:`, error);
        return [];
      }
    });
    
    // Wait for all chapter studies to be fetched
    const allChapterTasks = await Promise.all(chapterStudiesPromises);
    
    // Flatten the array of arrays
    for (const chapterTasks of allChapterTasks) {
      tasks.push(...chapterTasks);
    }
    
    console.log(`✅ API scan complete! Found ${tasks.length} studies across ${chapters.length} chapters`);
    showToast(`Found ${tasks.length} studies`, 'success');
    
    return tasks;
    
  } catch (error) {
    console.error('❌ API scan failed:', error);
    showToast('API scan failed - check console', 'error');
    throw error;
  }
}

/**
 * Extract the course/opening name from the page
 * Usually found in the main h1 element
 */
function extractCourseName(): string {
  // Try to find the main title (h1)
  const h1 = document.querySelector('h1');
  if (h1?.textContent?.trim()) {
    return h1.textContent.trim();
  }
  
  // Fallback: Try page title
  const pageTitle = document.title;
  if (pageTitle && !pageTitle.includes('Chessly')) {
    return pageTitle.trim();
  }
  
  // Last resort
  return 'Unknown Course';
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Show toast notification on page
 */
function showToast(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
  let toast = document.getElementById('chessly-extractor-toast');
  
  // Create toast if it doesn't exist
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'chessly-extractor-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      top: '10px',
      right: '10px',
      padding: '12px 16px',
      borderRadius: '6px',
      fontSize: '14px',
      fontWeight: '500',
      zIndex: '999999',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      transition: 'all 0.3s ease',
      maxWidth: '300px',
      color: 'white'
    });
    document.body.appendChild(toast);
  }
  
  // Set color based on type
  const colors = {
    info: '#2196F3',
    success: '#4CAF50',
    error: '#f44336'
  };
  
  toast.style.background = colors[type];
  toast.style.display = 'block';
  toast.textContent = `♟️ ${message}`;
  
  // Auto-hide after 3 seconds for success/error, keep info visible
  if (type !== 'info') {
    setTimeout(() => {
      if (toast) {
        toast.style.display = 'none';
      }
    }, 3000);
  }
}

// Visual feedback: Show ready indicator briefly on load
setTimeout(() => {
  showToast('Chessly Extractor Ready', 'success');
}, 500);

// Export for testing (if needed)
export { scanPage, runExtractionPipeline };
