// logic.js
const ChesslyLogic = {

    buildTreeFromUrl: function(href) {
        try {
            const url = new URL(href);
            const encodedLines = url.searchParams.getAll('lines');
            
            const variations = encodedLines.map((l, index) => ({
                id: index + 1,
                moves: decodeURIComponent(l).split(',')
            }));

            if (variations.length === 0) return null;

            if (variations.length === 1) {
                return this.buildLinearTree(variations[0]);
            }

            return this.recursiveTreeBuilder(variations, 0, 0, []);
        } catch (e) {
            console.error("Tree Build Error", e);
            return null;
        }
    },

    buildLinearTree: function(variation) {
        const moves = variation.moves;
        const nodes = [];
        const chess = new Chess();
        const limit = Math.min(moves.length, 25);
        const pathSoFar = [];

        for (let i = 0; i < limit; i++) {
            const moveSan = moves[i];
            const fenBefore = chess.fen();
            const result = chess.move(moveSan);
            if (!result) break; 

            pathSoFar.push(moveSan);

            nodes.push({
                fen: fenBefore,
                move: moveSan,
                moveNumber: Math.floor(i / 2) + 1,
                depth: 0,
                label: "",
                path: [...pathSoFar] // Save copy of path
            });
        }
        return nodes;
    },

        recursiveTreeBuilder: function(subset, checkIndex, depth, pathSoFar) {
        if (subset.length === 0) return [];

        let splitIndex = checkIndex;
        const MAX_MOVE_DEPTH = 100; 
        let iterations = 0;
        
        while (iterations < MAX_MOVE_DEPTH) {
            const refMove = subset[0].moves[splitIndex];
            if (!refMove) break; 
            const allMatch = subset.every(v => v.moves[splitIndex] === refMove);
            if (!allMatch) break; 
            splitIndex++; iterations++;
        }

        const groups = {};
        subset.forEach(v => {
            const move = v.moves[splitIndex];
            if (!move) return; 
            if (!groups[move]) groups[move] = [];
            groups[move].push(v);
        });

        let results = [];

        Object.keys(groups).forEach(move => {
            const groupVars = groups[move];
            const exampleLine = groupVars[0].moves;
            const chess = new Chess();
            
            // Build the path up to this node
            const currentPath = exampleLine.slice(0, splitIndex);
            
            for (let i = 0; i < splitIndex; i++) {
                chess.move(exampleLine[i]);
            }

            const node = {
                fen: chess.fen(), 
                move: move, 
                moveNumber: Math.floor(splitIndex / 2) + 1,
                depth: depth, 
                label: groupVars.map(v => `#${v.id}`).join(', '),
                path: [...currentPath, move] // The unique path to this node
            };
            results.push(node);

            if (groupVars.length > 1) {
                // Pass the new path down to children
                const children = this.recursiveTreeBuilder(groupVars, splitIndex + 1, depth + 1, node.path);
                results = results.concat(children);
            }
        });

        return results;
    },

    pruneOldCache: function(currentDayIndex) {
        chrome.storage.local.get(null, (items) => {
            const keysToRemove = [];
            Object.keys(items).forEach(key => {
                if (key.startsWith("stats_") && !key.endsWith(`_d${currentDayIndex}`)) {
                    keysToRemove.push(key);
                }
            });
            if (keysToRemove.length > 0) chrome.storage.local.remove(keysToRemove);
        });
    },

    fetchDataForTree: async function(treeNodes, lowElo, highElo) {
        const uniqueFens = [...new Set(treeNodes.map(n => n.fen))];
        const entries = [];
        const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));

        this.pruneOldCache(dayIndex);

        for (const fen of uniqueFens) {
            const cacheKey = `stats_${fen.replace(/\s/g, '_')}_${lowElo}_${highElo}_d${dayIndex}`;

            try {
                const cachedData = await new Promise(resolve => {
                    chrome.storage.local.get(cacheKey, (result) => resolve(result[cacheKey]));
                });

                if (cachedData) {
                    entries.push([fen, cachedData]);
                } else {
                    const p1 = new Promise(resolve => chrome.runtime.sendMessage({ action: "fetchStats", fen, rating: lowElo }, resolve));
                    const p2 = new Promise(resolve => chrome.runtime.sendMessage({ action: "fetchStats", fen, rating: highElo }, resolve));
                    
                    const [res1, res2] = await Promise.all([p1, p2]);

                    if (res1?.error || res2?.error) {
                        entries.push([fen, { low: null, high: null }]);
                        continue;
                    }

                    const resultData = { 
                        low: res1 && res1.data ? res1.data : null, 
                        high: res2 && res2.data ? res2.data : null 
                    };

                    const toSave = {};
                    toSave[cacheKey] = resultData;
                    chrome.storage.local.set(toSave);

                    entries.push([fen, resultData]);
                }
            } catch (err) {
                entries.push([fen, { low: null, high: null }]);
            }
        }
        return new Map(entries);
    }
};