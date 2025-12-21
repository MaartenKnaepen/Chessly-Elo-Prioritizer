/**
 * Network Fetch Interceptor (MAIN World Script)
 * This script runs in the page context (not isolated content script)
 * and intercepts fetch responses to capture study move data directly from the wire.
 */

(function() {
  'use strict';

  console.log('🌐 Chessly Fetch Interceptor loaded (MAIN world)');

  // Store the original fetch function
  const originalFetch = window.fetch;

  // Monkey-patch window.fetch
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    
    // LOG EVERY FETCH (per plan requirement)
    console.log('📡 Fetch:', url);
    
    try {
      // Call the original fetch
      const response = await originalFetch.apply(this, args);
      
      // RELAXED FILTER: Check for trpc, batch, study, or api patterns
      const isPotentialData = 
        url.includes('trpc') || 
        url.includes('batch') ||
        url.includes('/study') || 
        url.includes('/api/') ||
        url.includes('/_next/data/');
      
      if (isPotentialData && response.ok) {
        console.log('🔍 Potential data endpoint detected:', url);
        
        // Clone the response so we don't consume the original
        const clonedResponse = response.clone();
        
        // Try to parse as JSON
        clonedResponse.json()
          .then(data => {
            console.log('📦 Response parsed as JSON:', url);
            console.log('📊 JSON keys:', Object.keys(data || {}).join(', '));
            
            // DEEP SEARCH: Check for move data in nested objects
            const dataString = JSON.stringify(data);
            const hasMoveData = 
              data?.lines || 
              data?.moves || 
              data?.pgn || 
              data?.pageProps?.lines ||
              data?.pageProps?.moves ||
              data?.result?.lines ||
              data?.result?.moves ||
              // Search nested objects
              dataString.includes('"lines"') ||
              dataString.includes('"moves"') ||
              dataString.includes('"pgn"') ||
              // Chess move patterns
              dataString.includes('e4') || 
              dataString.includes('Nf3') ||
              dataString.includes('d4') ||
              dataString.includes('c5');
            
            if (hasMoveData) {
              console.log('✅ Found move data in fetch response!');
              console.log('📝 Data structure sample:', JSON.stringify(data, null, 2).substring(0, 500));
              
              // Send to content script via postMessage
              window.postMessage({
                type: 'CHESSLY_DATA',
                data: data,
                url: url
              }, '*');
            } else {
              console.log('⚠️ No move data found in response');
            }
          })
          .catch(err => {
            // Not JSON or parse error
            console.debug('⚠️ Response not JSON:', err.message);
          });
      }
      
      // Return the original response
      return response;
      
    } catch (error) {
      console.error('❌ Fetch interceptor error:', error);
      throw error;
    }
  };

  console.log('✅ Fetch interceptor installed - monitoring all network requests');
})();
