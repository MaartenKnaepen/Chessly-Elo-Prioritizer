import { useEffect, useState } from 'react';
import type { ExtractedLine, Message, LineEnrichedPayload, StatusResponse, LichessSettings } from '../types';

type SortField = keyof ExtractedLine | 'totalGames' | 'none';
type SortOrder = 'asc' | 'desc';

function App() {
  const [lines, setLines] = useState<ExtractedLine[]>([]);
  const [filteredLines, setFilteredLines] = useState<ExtractedLine[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('all');
  const [courses, setCourses] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [sortField, setSortField] = useState<SortField>('none');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [settings, setSettings] = useState<LichessSettings>({
    speeds: ['blitz', 'rapid', 'classical'],
    ratings: [1600, 1800, 2000, 2200, 2500]
  });

  // Helper function to format time control labels
  const formatSpeedLabel = (speed: string): string => {
    // Insert space before capital letters (e.g., "ultraBullet" -> "Ultra Bullet")
    return speed.replace(/([A-Z])/g, ' $1').trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  // Load initial data on mount
  useEffect(() => {
    loadData();
    loadStatus();
    loadSettings();

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

  // Update filtered and sorted lines when lines, course, or sorting changes
  useEffect(() => {
    let filtered = selectedCourse === 'all' 
      ? [...lines] 
      : lines.filter(line => line.opening === selectedCourse);
    
    // Apply sorting
    if (sortField !== 'none') {
      filtered.sort((a, b) => {
        if (sortField === 'totalGames') {
          // Sort by total games
          const aTotal = a.stats?.total || 0;
          const bTotal = b.stats?.total || 0;
          return sortOrder === 'desc' ? bTotal - aTotal : aTotal - bTotal;
        } else if (sortField === 'moves') {
          // Sort by moves - compare as strings
          const aMoves = Array.isArray(a.moves) ? a.moves.join(' ') : String(a.moves);
          const bMoves = Array.isArray(b.moves) ? b.moves.join(' ') : String(b.moves);
          const comparison = aMoves.localeCompare(bMoves);
          return sortOrder === 'desc' ? -comparison : comparison;
        } else {
          // String comparison for other fields (opening, chapter, study, variation)
          const aValue = String(a[sortField as keyof ExtractedLine] || '');
          const bValue = String(b[sortField as keyof ExtractedLine] || '');
          const comparison = aValue.localeCompare(bValue);
          return sortOrder === 'desc' ? -comparison : comparison;
        }
      });
    }
    
    setFilteredLines(filtered);
  }, [lines, selectedCourse, sortField, sortOrder]);

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

  const loadSettings = async () => {
    const result = await chrome.storage.local.get('lichess_settings');
    if (result.lichess_settings) {
      setSettings(result.lichess_settings);
    }
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

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Toggle order
      setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      // Set new field
      setSortField(field);
      // Default to 'desc' for totalGames, 'asc' for everything else
      setSortOrder(field === 'totalGames' ? 'desc' : 'asc');
    }
  };

  const handleSpeedChange = (speed: string) => {
    setSettings(prev => {
      const speeds = prev.speeds.includes(speed)
        ? prev.speeds.filter(s => s !== speed)
        : [...prev.speeds, speed];
      return { ...prev, speeds };
    });
  };

  const handleRatingChange = (rating: number) => {
    setSettings(prev => {
      const ratings = prev.ratings.includes(rating)
        ? prev.ratings.filter(r => r !== rating)
        : [...prev.ratings, rating];
      return { ...prev, ratings };
    });
  };

  const handleApplySettings = async () => {
    // Validate at least one option selected
    if (settings.speeds.length === 0) {
      alert('Please select at least one speed');
      return;
    }
    if (settings.ratings.length === 0) {
      alert('Please select at least one rating');
      return;
    }

    // Save settings
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: settings });
    
    // Refresh stats
    await chrome.runtime.sendMessage({ type: 'REFRESH_STATS' });
    
    // Clear local lines to show refreshing state
    setLines([]);
    
    setShowSettings(false);
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
          <button onClick={() => setShowSettings(!showSettings)}>
            ⚙️ Settings
          </button>
          <button onClick={exportToJSON} disabled={lines.length === 0}>
            Export JSON
          </button>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div className="settings-panel">
          <h3>Lichess Statistics Filters</h3>
          <div className="settings-content">
            <div className="settings-group">
              <h4>Time Controls:</h4>
              <div className="checkbox-group">
                {['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'].map(speed => (
                  <label key={speed}>
                    <input
                      type="checkbox"
                      checked={settings.speeds.includes(speed)}
                      onChange={() => handleSpeedChange(speed)}
                    />
                    {formatSpeedLabel(speed)}
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-group">
              <h4>Rating Ranges:</h4>
              <div className="checkbox-group">
                {[400, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].map(rating => (
                  <label key={rating}>
                    <input
                      type="checkbox"
                      checked={settings.ratings.includes(rating)}
                      onChange={() => handleRatingChange(rating)}
                    />
                    {rating}+
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="settings-actions">
            <button onClick={handleApplySettings} className="apply-button">
              Apply & Refresh Stats
            </button>
            <button onClick={() => setShowSettings(false)} className="cancel-button">
              Cancel
            </button>
          </div>
          <p className="settings-note">
            Note: Applying new settings will re-fetch all Lichess statistics. This may take some time.
          </p>
        </div>
      )}

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
                <th 
                  onClick={() => handleSort('opening')} 
                  className="sortable-header"
                  title="Click to sort by Opening"
                >
                  Opening {sortField === 'opening' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th 
                  onClick={() => handleSort('chapter')} 
                  className="sortable-header"
                  title="Click to sort by Chapter"
                >
                  Chapter {sortField === 'chapter' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th 
                  onClick={() => handleSort('study')} 
                  className="sortable-header"
                  title="Click to sort by Study"
                >
                  Study {sortField === 'study' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th 
                  onClick={() => handleSort('variation')} 
                  className="sortable-header"
                  title="Click to sort by Variation"
                >
                  Variation {sortField === 'variation' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th 
                  onClick={() => handleSort('moves')} 
                  className="sortable-header"
                  title="Click to sort by Moves"
                >
                  Moves {sortField === 'moves' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th 
                  onClick={() => handleSort('totalGames')} 
                  className="sortable-header"
                  title="Click to sort by Total Games"
                >
                  Total Games {sortField === 'totalGames' && (sortOrder === 'desc' ? '▼' : '▲')}
                </th>
                <th>Stats (Lichess)</th>
              </tr>
            </thead>
            <tbody>
              {filteredLines.map((line, index) => {
                const stats = formatStats(line);
                const totalGames = line.stats?.total || 0;
                return (
                  <tr key={index}>
                    <td>{line.opening}</td>
                    <td>{line.chapter}</td>
                    <td>{line.study}</td>
                    <td>{line.variation}</td>
                    <td className="moves-cell">{line.moves.join(' ')}</td>
                    <td className="total-games-cell">
                      {totalGames > 0 ? totalGames.toLocaleString() : '-'}
                    </td>
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
