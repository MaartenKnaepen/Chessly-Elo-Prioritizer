/**
 * Content Script - Runs on Chessly pages
 * Handles "Phase 1" - DOM scraping and chapter expansion
 * Collects study URLs and sends them to the background script
 */

import type { CrawlTask, Message, ScanCompletePayload } from '../types';

console.log('🔧 Content script initialized on Chessly page');

// Configuration
const EXPANSION_DELAY_MS = 800; // Wait for chapters to expand
const MAX_WAIT_ATTEMPTS = 10;   // Max polls waiting for content to appear

/**
 * Listen for SCAN_PAGE message from background
 */
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'SCAN_PAGE') {
    console.log('🔍 Received SCAN_PAGE command');
    
    scanPage()
      .then(tasks => {
        console.log(`✅ Scan complete! Found ${tasks.length} studies`);
        
        const payload: ScanCompletePayload = {
          tasks,
          count: tasks.length
        };
        
        // Send SCAN_COMPLETE message to background
        chrome.runtime.sendMessage({
          type: 'SCAN_COMPLETE',
          payload
        });
        
        sendResponse({ success: true, payload });
      })
      .catch(error => {
        console.error('❌ Scan failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
});

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
    await expandChapter(chapterDiv);
  }
  
  // Extract study links
  const studies = extractStudiesFromChapter(chapterDiv, chapterName, courseName);
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
async function expandChapter(chapterDiv: HTMLDivElement): Promise<void> {
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
  
  // Wait for content to appear
  await waitForChapterContent(chapterDiv);
}

/**
 * Wait for chapter content to become visible after expansion
 */
async function waitForChapterContent(chapterDiv: HTMLDivElement): Promise<void> {
  let attempts = 0;
  
  while (attempts < MAX_WAIT_ATTEMPTS) {
    // Check if study links are now visible
    const studyLinks = chapterDiv.querySelectorAll('a[href*="study"]');
    
    if (studyLinks.length > 0) {
      // Content appeared!
      return;
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
function extractStudiesFromChapter(chapterDiv: HTMLDivElement, chapterName: string, courseName: string): CrawlTask[] {
  const tasks: CrawlTask[] = [];
  
  // Find all study links (assuming they contain "/studies/" in the URL)
  const studyLinks = chapterDiv.querySelectorAll<HTMLAnchorElement>('a[href*="/studies/"]');
  
  studyLinks.forEach(link => {
    const url = link.href;
    
    // Filter: Exclude non-study links (video, quizzes, drill-shuffle)
    if (url.endsWith('/video') || url.endsWith('/quizzes') || url.endsWith('/drill-shuffle')) {
      // Skip these links - they're not the "Learn" study link we want
      return;
    }
    
    // Extract clean study name using robust DOM traversal
    let studyName = 'Unknown Study';
    
    // Step 1: Traverse up to the study container
    const studyContainer = link.closest('div[class*="ChapterStudy_chapterStudyContainer"]');
    
    if (studyContainer) {
      // Step 2: Inside that container, query for the title element
      const titleElement = studyContainer.querySelector('div[class*="bold13"], span[class*="bold13"]');
      
      if (titleElement) {
        studyName = titleElement.textContent?.trim() || 'Unknown Study';
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

// Visual feedback: Add a subtle indicator that the content script is active
const indicator = document.createElement('div');
indicator.id = 'chessly-extractor-indicator';
Object.assign(indicator.style, {
  position: 'fixed',
  top: '10px',
  right: '10px',
  background: '#4CAF50',
  color: 'white',
  padding: '8px 12px',
  borderRadius: '4px',
  fontSize: '12px',
  fontWeight: 'bold',
  zIndex: '999999',
  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  display: 'none'
});
indicator.textContent = '♟️ Chessly Extractor Ready';
document.body.appendChild(indicator);

// Show indicator briefly on load
indicator.style.display = 'block';
setTimeout(() => {
  indicator.style.display = 'none';
}, 3000);

// Export for testing (if needed)
export { scanPage, processChapter };
