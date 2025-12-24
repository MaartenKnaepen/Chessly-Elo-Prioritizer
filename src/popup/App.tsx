import React, { useState, useEffect } from 'react';
import type { StatusResponse, Message } from '../types';

const App: React.FC = () => {
  const [status, setStatus] = useState<StatusResponse>({
    state: 'idle',
    lineCount: 0,
    queueLength: 0
  });
  const [isLoading, setIsLoading] = useState(false);

  // Fetch status on mount and set up message listener
  useEffect(() => {
    fetchStatus();

    // Listen for updates from background
    const messageListener = (message: Message) => {
      if (message.type === 'ENRICH_PROGRESS' || 
          message.type === 'CRAWL_COMPLETE' ||
          message.type === 'ENRICH_COMPLETE') {
        fetchStatus();
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    // Poll status every 2 seconds when not idle
    const interval = setInterval(() => {
      if (status.state !== 'idle' && status.state !== 'complete') {
        fetchStatus();
      }
    }, 2000);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      clearInterval(interval);
    };
  }, [status.state]);

  const fetchStatus = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      setStatus(response);
    } catch (error) {
      console.error('Failed to fetch status:', error);
    }
  };

  const handleStartCrawl = async () => {
    setIsLoading(true);
    try {
      // Start the crawl
      await chrome.runtime.sendMessage({ type: 'START_CRAWL' });
      
      // Auto-open dashboard immediately so user can see real-time progress
      await chrome.tabs.create({ 
        url: chrome.runtime.getURL('src/dashboard/index.html')
      });
      
      // Status will be updated via message listener
    } catch (error) {
      console.error('Failed to start crawl:', error);
      setStatus({
        ...status,
        state: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenDashboard = async () => {
    try {
      await chrome.tabs.create({ 
        url: chrome.runtime.getURL('src/dashboard/index.html')
      });
    } catch (error) {
      console.error('Failed to open dashboard:', error);
    }
  };

  const getStatusClass = () => {
    switch (status.state) {
      case 'crawling':
        return 'crawling';
      case 'enriching':
        return 'enriching';
      case 'error':
        return 'error';
      case 'complete':
        return 'complete';
      default:
        return '';
    }
  };

  const getStatusMessage = () => {
    switch (status.state) {
      case 'idle':
        return 'Ready to extract repertoire data';
      case 'crawling':
        return status.progress 
          ? `Crawling studies... (${status.progress.current}/${status.progress.total})`
          : 'Crawling studies...';
      case 'enriching':
        const queueInfo = status.queueLength > 0 
          ? ` | Queue: ${status.queueLength}` 
          : '';
        return `Enriching with Lichess stats...${queueInfo}`;
      case 'complete':
        return 'Extraction complete!';
      case 'error':
        return `Error: ${status.error || 'Unknown error'}`;
      default:
        return 'Unknown state';
    }
  };

  const getProgressPercent = (): number => {
    if (!status.progress) return 0;
    return (status.progress.current / status.progress.total) * 100;
  };

  return (
    <div className="container">
      <div className="header">
        <h1>♟️ Chessly ELO Prioritizer</h1>
        <p>Extract and enrich your repertoire</p>
      </div>

      <div className={`status-section ${getStatusClass()}`}>
        <div className="status-title">
          {status.state === 'idle' && '⚡ Ready'}
          {status.state === 'crawling' && '🔍 Crawling'}
          {status.state === 'enriching' && '🎨 Enriching'}
          {status.state === 'complete' && '✅ Complete'}
          {status.state === 'error' && '❌ Error'}
        </div>
        <div className="status-message">{getStatusMessage()}</div>

        {status.progress && (
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ width: `${getProgressPercent()}%` }}
            />
          </div>
        )}

        {(status.state === 'enriching' || status.state === 'complete') && (
          <div className="line-count">
            {status.lineCount} lines extracted
            {status.state === 'enriching' && status.queueLength > 0 && (
              <span style={{ marginLeft: '8px', color: '#7f8c8d', fontSize: '12px' }}>
                ({status.queueLength} queued for Lichess)
              </span>
            )}
          </div>
        )}
      </div>

      <div className="button-group">
        <button
          className="button"
          onClick={handleStartCrawl}
          disabled={isLoading || status.state === 'crawling' || status.state === 'enriching'}
        >
          {isLoading || status.state === 'crawling' || status.state === 'enriching' ? (
            <>
              <span className="spinner"></span>
              Processing...
            </>
          ) : (
            'Start Extraction'
          )}
        </button>

        <button
          className="button secondary"
          onClick={handleOpenDashboard}
        >
          📊 Open Dashboard
        </button>
      </div>

      <div className="footer">
        Fast & Responsive Architecture • Powered by Vite + React
      </div>
    </div>
  );
};

export default App;
