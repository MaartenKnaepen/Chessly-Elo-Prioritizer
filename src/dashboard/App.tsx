import { useEffect, useState } from 'react';
import type { ExtractedLine, Message, LineEnrichedPayload, StatusResponse } from '../types';

function App() {
  const [lines, setLines] = useState<ExtractedLine[]>([]);
  const [filteredLines, setFilteredLines] = useState<ExtractedLine[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('all');
  const [courses, setCourses] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);

  // Load initial data on mount
  useEffect(() => {
    loadData();
    loadStatus();

    // Listen for real-time updates
    const messageListener = (message: Message) => {
      if (message.type === 'LINE_ENRICHED') {
        const payload = message.payload as LineEnrichedPayload;
        handleLineEnriched(payload.line);
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);

    // Poll status every second
    const statusInterval = setInterval(loadStatus, 1000);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      clearInterval(statusInterval);
    };
  }, []);

  // Update filtered lines when lines or selected course changes
  useEffect(() => {
    if (selectedCourse === 'all') {
      setFilteredLines(lines);
    } else {
      setFilteredLines(lines.filter(line => line.opening === selectedCourse));
    }
  }, [lines, selectedCourse]);

  // Extract unique courses when lines change
  useEffect(() => {
    const uniqueCourses = Array.from(new Set(lines.map(line => line.opening)));
    setCourses(uniqueCourses.sort());
  }, [lines]);

  const loadData = async () => {
    const result = await chrome.storage.local.get('extracted_lines');
    const storedLines: ExtractedLine[] = result.extracted_lines || [];
    setLines(storedLines);
  };

  const loadStatus = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    setStatus(response);
  };

  const handleLineEnriched = (line: ExtractedLine) => {
    setLines(prev => {
      // Check if line already exists (avoid duplicates)
      const exists = prev.some(l => 
        l.chapter === line.chapter && 
        l.study === line.study && 
        l.variation === line.variation
      );
      
      if (exists) {
        return prev;
      }
      
      return [...prev, line];
    });
  };

  const exportToJSON = () => {
    const dataStr = JSON.stringify(lines, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chessly-export-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const formatStats = (line: ExtractedLine) => {
    if (!line.stats || !line.stats.total || line.stats.total === 0) {
      return { text: 'No data', percentages: null };
    }

    const { white, draws, black, total } = line.stats;
    const whitePercent = ((white / total) * 100).toFixed(1);
    const drawPercent = ((draws / total) * 100).toFixed(1);
    const blackPercent = ((black / total) * 100).toFixed(1);

    return {
      text: `W: ${white} (${whitePercent}%) | D: ${draws} (${drawPercent}%) | B: ${black} (${blackPercent}%)`,
      percentages: {
        white: (white / total) * 100,
        draws: (draws / total) * 100,
        black: (black / total) * 100
      }
    };
  };

  return (
    <div className="dashboard">
      {/* Header */}
      <div className="dashboard-header">
        <h1>♟️ Chessly Explorer Dashboard</h1>
        <div className="dashboard-header-actions">
          {status && (
            <>
              <span className={`status-badge ${status.state}`}>
                {status.state}
              </span>
              <span style={{ color: '#ecf0f1', fontSize: '14px' }}>
                Lines: {status.lineCount} | Queue: {status.queueLength}
              </span>
            </>
          )}
          <button onClick={exportToJSON} disabled={lines.length === 0}>
            Export JSON
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      {courses.length > 0 && (
        <div className="filter-bar">
          <label htmlFor="course-filter">Filter by Opening/Course:</label>
          <select
            id="course-filter"
            value={selectedCourse}
            onChange={(e) => setSelectedCourse(e.target.value)}
          >
            <option value="all">All Courses ({lines.length} lines)</option>
            {courses.map(course => {
              const count = lines.filter(l => l.opening === course).length;
              return (
                <option key={course} value={course}>
                  {course} ({count} lines)
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Table */}
      <div className="table-container">
        {filteredLines.length === 0 ? (
          <div className="empty-state">
            <h2>No Data Yet</h2>
            <p>Start an extraction from the popup to see data here.</p>
            <p style={{ marginTop: '8px', fontSize: '14px' }}>
              Data will appear in real-time as it's extracted and enriched.
            </p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Opening</th>
                <th>Chapter</th>
                <th>Study</th>
                <th>Variation</th>
                <th>Moves</th>
                <th>Stats (Lichess)</th>
              </tr>
            </thead>
            <tbody>
              {filteredLines.map((line, index) => {
                const stats = formatStats(line);
                return (
                  <tr key={index}>
                    <td>{line.opening}</td>
                    <td>{line.chapter}</td>
                    <td>{line.study}</td>
                    <td>{line.variation}</td>
                    <td className="moves-cell">{line.moves.join(' ')}</td>
                    <td className="stats-cell">
                      <div>{stats.text}</div>
                      {stats.percentages && (
                        <div className="stats-bar">
                          <div
                            className="stats-bar-white"
                            style={{ width: `${stats.percentages.white}%` }}
                            title={`White: ${stats.percentages.white.toFixed(1)}%`}
                          />
                          <div
                            className="stats-bar-draw"
                            style={{ width: `${stats.percentages.draws}%` }}
                            title={`Draws: ${stats.percentages.draws.toFixed(1)}%`}
                          />
                          <div
                            className="stats-bar-black"
                            style={{ width: `${stats.percentages.black}%` }}
                            title={`Black: ${stats.percentages.black.toFixed(1)}%`}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default App;
