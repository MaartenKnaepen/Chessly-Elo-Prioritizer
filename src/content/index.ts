/**
 * Content Script - Runs on Chessly pages
 * Handles scanning, API crawling, and streaming results to background
 * This script now drives the entire extraction process
 */

import type { CrawlTask, Message, StudyExtractedPayload } from '../types';
import { fetchStudyData } from './api-crawler';

console.log('🔧 Content script initialized on Chessly page');

// Configuration
const EXPANSION_DELAY_MS = 1500; // Wait for chapters to expand (increased for sluggish UI)
const MAX_WAIT_ATTEMPTS = 10;    // Max polls waiting for content to appear
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
 * Main page scanning logic
 * Expands all chapters and collects study URLs
 */
async function scanPage(): Promise<CrawlTask[]> {
  console.log('🚀 Starting page scan...');
  
  const tasks: CrawlTask[] = [];
  
  // Capture the Course Name (usually the main h1 on the page)
  const courseName = extractCourseName();
  console.log(`📖 Course: ${courseName}`);
  
  // Find all chapter divs
  const chapterDivs = document.querySelectorAll<HTMLDivElement>('div[id^="chapter-"]');
  
  if (chapterDivs.length === 0) {
    throw new Error('No chapters found on this page. Are you on the Chessly repertoire overview?');
  }
  
  console.log(`📚 Found ${chapterDivs.length} chapters`);
  
  // Process each chapter
  for (let i = 0; i < chapterDivs.length; i++) {
    const chapterDiv = chapterDivs[i];
    console.log(`📖 Processing chapter ${i + 1}/${chapterDivs.length}`);
    
    try {
      const chapterTasks = await processChapter(chapterDiv, courseName);
      tasks.push(...chapterTasks);
    } catch (error) {
      console.warn(`⚠️ Failed to process chapter ${i + 1}:`, error);
      // Continue with next chapter
    }
  }
  
  return tasks;
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
 * Process a single chapter - expand if needed and extract studies
 */
async function processChapter(chapterDiv: HTMLDivElement, courseName: string): Promise<CrawlTask[]> {
  // Capture the chapter ID for DOM re-querying after React re-renders
  const chapterId = chapterDiv.id;
  if (!chapterId) {
    console.warn('⚠️ Chapter div has no ID, skipping...');
    return [];
  }
  
  // Get clean chapter name - target the specific title element to exclude progress text
  let chapterName = 'Unknown Chapter';
  
  // Look for the Chapter Title element (usually .Chapter_chapterTitle__sbxbv or similar)
  const titleElement = chapterDiv.querySelector('[class*="Chapter_chapterTitle"], [class*="chapterTitle"]');
  if (titleElement) {
    // Extract only the text nodes, ignoring child elements that might contain "100%"
    // Get first text node or use a more specific selector
    let titleText = '';
    
    // Try to get the first child text node directly
    for (const node of titleElement.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim() || '';
        if (text && !text.match(/^\d+%$/)) {
          // Found text that's not just a percentage
          titleText = text;
          break;
        }
      }
    }
    
    // If no text node found, fall back to textContent and clean it
    if (!titleText) {
      titleText = titleElement.textContent?.trim() || '';
      // Remove percentage patterns and extra whitespace
      titleText = titleText.replace(/\d+%/g, '').trim();
    }
    
    chapterName = titleText.replace(/\s+/g, ' ').trim();
  }
  
  // Fallback to old method if new method fails
  if (!chapterName || chapterName === '') {
    const chapterHeader = chapterDiv.querySelector('.chapter-header, [class*="chapter"], h2, h3');
    chapterName = chapterHeader?.textContent?.trim().replace(/\d+%/g, '').replace(/\s+/g, ' ').trim() || 'Unknown Chapter';
  }
  
  console.log(`  📂 Chapter: ${chapterName}`);
  
  // Check if chapter is collapsed
  const isCollapsed = await isChapterCollapsed(chapterDiv);
  
  if (isCollapsed) {
    console.log(`  🔓 Expanding chapter...`);
    await expandChapter(chapterId);
  }
  
  // Extract study links (pass ID instead of element)
  const studies = extractStudiesFromChapter(chapterId, chapterName, courseName);
  console.log(`  ✅ Found ${studies.length} studies`);
  
  return studies;
}

/**
 * Check if a chapter is collapsed
 */
async function isChapterCollapsed(chapterDiv: HTMLDivElement): Promise<boolean> {
  // Check if the chapter div has the "open" class (React-generated class pattern)
  // If className includes "Chapter_open" or "open", it's expanded
  const className = chapterDiv.className || '';
  
  if (className.includes('Chapter_open') || className.includes('open')) {
    // Chapter is already open/expanded
    return false;
  }
  
  // If the class doesn't include "open", it's collapsed and needs expansion
  return true;
}

/**
 * Expand a collapsed chapter
 */
async function expandChapter(chapterId: string): Promise<void> {
  // Re-query the element by ID to get fresh DOM reference
  const chapterDiv = document.getElementById(chapterId);
  
  if (!chapterDiv) {
    console.warn('  ⚠️ Chapter element not found, may have been removed');
    return;
  }
  
  // Find the clickable header - prioritize React-generated class pattern
  const clickable = chapterDiv.querySelector<HTMLElement>(
    'div[class*="Chapter_chapterHeader"], .chapter-header, [class*="chapter-header"], [class*="accordion"], button, h2, h3'
  );
  
  if (!clickable) {
    console.warn('  ⚠️ No clickable header found, assuming already expanded');
    return;
  }
  
  // Click to expand
  clickable.click();
  
  // Wait for content to appear (pass ID, not element)
  await waitForChapterContent(chapterId);
}

/**
 * Wait for chapter content to become visible after expansion
 */
async function waitForChapterContent(chapterId: string): Promise<void> {
  let attempts = 0;
  
  while (attempts < MAX_WAIT_ATTEMPTS) {
    // Re-query the element by ID to get fresh DOM reference after React re-render
    const freshDiv = document.getElementById(chapterId);
    
    if (!freshDiv) {
      console.warn('  ⚠️ Chapter element disappeared during wait');
      return;
    }
    
    // Find the container that holds study links
    const container = freshDiv.querySelector('div[class*="chapterStudyContainer"]');
    
    // Check if container exists and is visible (not display: none)
    if (container) {
      const computedStyle = window.getComputedStyle(container);
      const isVisible = computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden';
      
      if (isVisible) {
        // Check if study links are now visible
        const studyLinks = freshDiv.querySelectorAll('a[href*="study"]');
        
        if (studyLinks.length > 0) {
          // Content appeared and is visible!
          return;
        }
      }
    }
    
    // Wait a bit and try again
    await sleep(EXPANSION_DELAY_MS);
    attempts++;
  }
  
  console.warn('  ⚠️ Chapter content did not appear after expansion');
}

/**
 * Extract all study links from a chapter
 */
function extractStudiesFromChapter(chapterId: string, chapterName: string, courseName: string): CrawlTask[] {
  const tasks: CrawlTask[] = [];
  
  // Re-query the element by ID to get fresh DOM reference after React re-render
  const chapterDiv = document.getElementById(chapterId);
  
  if (!chapterDiv) {
    console.warn('  ⚠️ Chapter element not found during extraction');
    return [];
  }
  
  // Find all study links (assuming they contain "/studies/" in the URL)
  const studyLinks = chapterDiv.querySelectorAll<HTMLAnchorElement>('a[href*="/studies/"]');
  
  studyLinks.forEach(link => {
    const url = link.href;
    
    // Filter: Exclude non-study links (video, quizzes, drill-shuffle)
    if (url.endsWith('/video') || url.endsWith('/quizzes') || url.endsWith('/drill-shuffle')) {
      // Skip these links - they're not the "Learn" study link we want
      return;
    }
    
    // Extract clean study name using robust DOM traversal with wildcard selectors
    let studyName = 'Unknown Study';
    
    // Step 1: Traverse up to the study container (wildcard to ignore hash suffixes)
    // Match both 'ChapterStudy_chapterStudyContainer' (uppercase) and 'chapterStudyContainer' (lowercase)
    const studyContainer = link.closest('div[class*="chapterStudyContainer"]');
    
    if (studyContainer) {
      // Step 2: Inside that container, query for the title element (wildcard selectors)
      const titleElement = studyContainer.querySelector('[class*="bold13"], [class*="studyTitle"], [class*="title"]');
      
      if (titleElement) {
        // Make sure we're not grabbing the "Learn" button text
        const text = titleElement.textContent?.trim() || '';
        if (text && text.toLowerCase() !== 'learn' && text.length > 0) {
          studyName = text;
        }
      }
    }
    
    // Clean up the study name (remove extra whitespace, remove "Learn" if it's there)
    studyName = studyName.replace(/\s+/g, ' ').replace(/^Learn\s*/i, '').trim();
    
    // Log if we still couldn't find a proper name
    if (studyName === 'Unknown Study' || studyName === '') {
      console.warn(`  ⚠️ Could not extract study name for URL: ${url}`);
    }
    
    tasks.push({
      courseName,  // Add the course name to every task
      chapter: chapterName,
      study: studyName,
      url
    });
  });
  
  return tasks;
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
export { scanPage, processChapter, runExtractionPipeline };
