import { useState, useMemo, useCallback, useEffect } from 'react';
import { getLayoutedElements, extractSignature, getEventColor, nodeWidth, nodeHeight } from '../utils';

export function useTraceGraph({
  events,
  currentIndex,
  isGroupMode,
  collapsedPools,
  setCollapsedPools,
  searchQuery,
  hideAnonymous,
  visibleEvents,
  visibleCategories,
  showEdgeLabels,
  isFocusReleased
}) {
  const [rfNodes, setRfNodes] = useState([]);
  const [rfEdges, setRfEdges] = useState([]);

  // ==========================================
  // プロセス名・PIDの対応表
  // ==========================================
  const { nameToPid, pidToName } = useMemo(() => {
    const n2p = new Map();
    const p2n = new Map();
    
    events.forEach(evt => {
      const checkAndSet = (id, name) => {
        if (id && id.startsWith("#PID") && name && name !== "[]" && !name.startsWith("#PID")) {
          p2n.set(id, name);
          n2p.set(name, id);
        }
      };
      checkAndSet(evt.source, evt.source_name);
      checkAndSet(evt.target, evt.target_name);
    });
    
    return { nameToPid: n2p, pidToName: p2n };
  }, [events]);

  const getNormId = useCallback((id) => {
    return (id && !id.startsWith("#PID") && nameToPid.has(id)) ? nameToPid.get(id) : id;
  }, [nameToPid]);

  const getFinalName = useCallback((normId, rawName) => {
    return pidToName.get(normId) || rawName;
  }, [pidToName]);

  // ==========================================
  // プール抽出・所属判定
  // ==========================================
  const { groupCounts, groupInfo, pidToGroupId, groupMembers } = useMemo(() => {
    const pidToMap = new Map();
    const counts = new Map();
    const info = new Map();
    const members = new Map();

    events.forEach(evt => {
      if (evt.type === 'SPAWN') {
        const normSource = getNormId(evt.source);
        const normTarget = getNormId(evt.target);
        
        if (normSource && normTarget) {
          let sig = extractSignature(evt.payload);
          if (!sig || sig === 'nil') sig = 'Anonymous_Worker'; 
          
          const groupId = `pool-${normSource}-${sig}`;
          pidToMap.set(normTarget, groupId);
          counts.set(groupId, (counts.get(groupId) || 0) + 1);
          
          if (!info.has(groupId)) info.set(groupId, { parent: normSource, sig });
          if (!members.has(groupId)) members.set(groupId, new Set());
          
          members.get(groupId).add(normTarget);
        }
      }
    });
    
    return { groupCounts: counts, groupInfo: info, pidToGroupId: pidToMap, groupMembers: members };
  }, [events, getNormId]);

  const isPoolCollapsed = useCallback((groupId) => {
    if (collapsedPools.has(groupId)) return true;
    if (isGroupMode && !collapsedPools.has(`expanded-${groupId}`)) return true;
    return false;
  }, [collapsedPools, isGroupMode]);

  const togglePoolCollapse = useCallback((groupId) => {
    setCollapsedPools(prev => {
      const next = new Set(prev);
      if (isGroupMode) {
        if (next.has(`expanded-${groupId}`)) next.delete(`expanded-${groupId}`);
        else next.add(`expanded-${groupId}`);
      } else {
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
      }
      return next;
    });
  }, [isGroupMode, setCollapsedPools]);

  const getEffectiveId = useCallback((id) => {
    if (!isGroupMode) return id; 
    const gId = pidToGroupId.get(id);
    if (gId && (groupCounts.get(gId) || 0) >= 2 && isPoolCollapsed(gId)) return gId;
    return id;
  }, [pidToGroupId, groupCounts, isPoolCollapsed, isGroupMode]);

  // ==========================================
  // マスターグラフの構築
  // ==========================================
  const masterData = useMemo(() => {
    const allNodesMap = new Map();
    const allEdgesMap = new Map();
    const nLifecycles = new Map();
    const eLifecycles = new Map();

    events.forEach((evt, idx) => {
      const rawNormSource = getNormId(evt.source);
      const rawNormTarget = getNormId(evt.target);
      const effSource = rawNormSource ? getEffectiveId(rawNormSource) : null;
      const effTarget = rawNormTarget ? getEffectiveId(rawNormTarget) : null;

      if (rawNormSource && !nLifecycles.has(rawNormSource)) {
        nLifecycles.set(rawNormSource, { spawnAt: idx, exitAt: Infinity, history: [] });
      }
      if (rawNormTarget && !nLifecycles.has(rawNormTarget)) {
        nLifecycles.set(rawNormTarget, { spawnAt: idx, exitAt: Infinity, history: [] });
      }

      const processNode = (effId, rawId, name) => {
        if (!effId || allNodesMap.has(effId)) return;
        
        let displayLabel = effId;
        let nodeStyle = {};
        let isAnonymousNode = false;
        
        if (effId.startsWith('pool-')) {
          const info = groupInfo.get(effId);
          const count = groupCounts.get(effId);
          displayLabel = `Pool: ${info?.sig || 'Workers'}\n(${count} processes)`;
          nodeStyle = { borderStyle: 'solid', borderWidth: '2px', borderColor: '#4CAF50', padding: '10px 20px', borderRadius: '50px', backgroundColor: 'white', color: '#333', minWidth: '160px', fontSize: '11px', textAlign: 'center', fontWeight: 'bold', transition: 'all 0.3s ease', cursor: 'pointer' };
        } else {
          const isPidString = rawId.startsWith("#PID");
          const hasRealName = name && name !== "[]" && !name.startsWith("#PID");
          isAnonymousNode = !hasRealName && isPidString;
          
          displayLabel = hasRealName ? (isPidString ? `${name}\n(${rawId})` : name) : rawId;
          
          if (isAnonymousNode) {
            displayLabel = (
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <span style={{ position: 'absolute', top: '18px', left: '14px', fontSize: '9px', fontFamily: 'monospace', color: '#818cf8', whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none' }}>
                  {rawId}
                </span>
              </div>
            );
            nodeStyle = { width: 20, height: 20, borderRadius: '50%', backgroundColor: '#e0e7ff', borderStyle: 'solid', borderWidth: '2px', borderColor: '#818cf8', boxSizing: 'border-box', padding: 0, transition: 'all 0.3s ease' };
          } else {
            nodeStyle = { borderStyle: 'solid', borderWidth: '1px', borderColor: '#888', padding: '10px', borderRadius: '5px', backgroundColor: 'white', color: '#333', width: nodeWidth, fontSize: '11px', textAlign: 'center', wordBreak: 'break-all', transition: 'all 0.3s ease', whiteSpace: 'pre-wrap' };
          }
        }

        allNodesMap.set(effId, { 
          id: effId, 
          data: { rawId, rawName: name, isPool: effId.startsWith('pool-'), label: displayLabel, isAnonymousNode }, 
          position: { x: 0, y: 0 }, 
          style: nodeStyle 
        });
        
        if (!nLifecycles.has(effId)) {
          nLifecycles.set(effId, { spawnAt: idx, exitAt: Infinity, history: [] });
        }
      };

      if (effSource) processNode(effSource, rawNormSource, getFinalName(rawNormSource, evt.source_name));
      if (effTarget) processNode(effTarget, rawNormTarget, getFinalName(rawNormTarget, evt.target_name));

      if (evt.type === 'EXIT') {
        if (rawNormSource && nLifecycles.has(rawNormSource)) {
          const lc = nLifecycles.get(rawNormSource);
          lc.exitAt = idx;
          lc.exitReason = evt.payload;
        }
        if (effSource && effSource.startsWith('pool-') && nLifecycles.has(effSource)) {
          const lc = nLifecycles.get(effSource);
          lc.exits = lc.exits || [];
          lc.exits.push({ index: idx, reason: evt.payload });
        }
      }
      
      if (evt.type === 'LOCAL EVENT') {
        if (rawNormSource && nLifecycles.has(rawNormSource)) {
          nLifecycles.get(rawNormSource).history.push({ index: idx, state: evt.payload });
        }
        if (effSource && effSource.startsWith('pool-') && nLifecycles.has(effSource)) {
          nLifecycles.get(effSource).history.push({ index: idx, state: evt.payload });
        }
      }
      
      if (['SPAWN', 'SEND', 'RECEIVE'].includes(evt.type) && effSource && effTarget) {
        const edgeId = `e-${effSource}-${effTarget}`;
        const historyItem = { 
          index: idx, 
          payload: evt.payload, 
          type: evt.type,
          category: evt.category || 'app' // ← 追加
        };

        if (!allEdgesMap.has(edgeId)) {
          allEdgesMap.set(edgeId, { 
            id: edgeId, 
            source: effSource, 
            target: effTarget, 
            data: { types: new Set([evt.type]) } 
          });
          eLifecycles.set(edgeId, { spawnAt: idx, history: [historyItem] });
        } else {
          allEdgesMap.get(edgeId).data.types.add(evt.type); 
          eLifecycles.get(edgeId).history.push(historyItem);
        }
      }
    });

    const layouted = getLayoutedElements(
      Array.from(allNodesMap.values()), 
      Array.from(allEdgesMap.values()),
      isGroupMode ? groupMembers : null, 
      isPoolCollapsed
    );
    
    return { nodes: layouted.nodes, edges: layouted.edges, nLifecycles, eLifecycles };
  }, [events, getNormId, getFinalName, getEffectiveId, groupCounts, groupInfo, groupMembers, isPoolCollapsed, isGroupMode]);

  // ==========================================
  // フィルター処理
  // ==========================================
  const passesFilters = useCallback((evt) => {
    if (!evt || !visibleEvents[evt.type]) return false;
    
    // 【変更】category による単一判定
    const cat = evt.category || "app";
    if (visibleCategories && !visibleCategories[cat]) {
      return false;
    }

    // 無名プロセス除外（既存のまま）
    if (hideAnonymous) {
      const sNorm = getNormId(evt.source);
      const tNorm = getNormId(evt.target);
      const sNameFinal = getFinalName(sNorm, evt.source_name);
      const tNameFinal = getFinalName(tNorm, evt.target_name);
      const sAnon = evt.source && (!sNameFinal || sNameFinal === "[]" || sNameFinal.startsWith("#PID"));
      const tAnon = evt.target && (!tNameFinal || tNameFinal === "[]" || tNameFinal.startsWith("#PID"));
      const sPooled = sNorm && getEffectiveId(sNorm).startsWith('pool-');
      const tPooled = tNorm && getEffectiveId(tNorm).startsWith('pool-');
      if (sAnon && !sPooled) return false;
      if (tAnon && !tPooled) return false;
    }
    
    // 検索クエリ判定（既存のまま）
    if (searchQuery !== "") {
      if (searchQuery.startsWith('pool-')) {
        const sGroup = pidToGroupId.get(getNormId(evt.source));
        const tGroup = pidToGroupId.get(getNormId(evt.target));
        if (sGroup !== searchQuery && tGroup !== searchQuery) return false;
        return true; 
      }
      const q = searchQuery.toLowerCase();
      const sName = (getFinalName(getNormId(evt.source), evt.source_name) || "").toLowerCase();
      const tName = (getFinalName(getNormId(evt.target), evt.target_name) || "").toLowerCase();
      const sRaw = (getNormId(evt.source) || "").toLowerCase();
      const tRaw = (getNormId(evt.target) || "").toLowerCase();
      const pRaw = (evt.payload || "").toLowerCase();
      
      if (!sName.includes(q) && !tName.includes(q) && !sRaw.includes(q) && !tRaw.includes(q) && !pRaw.includes(q)) {
        return false;
      }
    }
    return true;
  }, [visibleEvents, visibleCategories, hideAnonymous, searchQuery, getNormId, getFinalName, getEffectiveId, pidToGroupId]);

  const filteredEvents = useMemo(() => {
    return events.map((evt, idx) => ({ ...evt, originalIndex: idx })).filter(passesFilters);
  }, [events, passesFilters]);

  // ==========================================
  // 動的スタイル生成ループ
  // ==========================================
  useEffect(() => {
    if (masterData.nodes.length === 0 || currentIndex < 0) { 
      setRfNodes([]); setRfEdges([]); return; 
    }

    const currentEvt = events[currentIndex];
    const curNormSource = currentEvt ? getEffectiveId(getNormId(currentEvt.source)) : null;
    const curNormTarget = currentEvt ? getEffectiveId(getNormId(currentEvt.target)) : null;
    const q = searchQuery.toLowerCase();
    const isEventVisible = currentEvt && visibleEvents[currentEvt.type];
    
    const currentActiveGroupMembers = new Map();
    groupMembers.forEach((memberPids, gId) => {
      const activePids = new Set();
      memberPids.forEach(pid => {
        const lc = masterData.nLifecycles.get(pid);
        if (lc && lc.spawnAt <= currentIndex) activePids.add(pid);
      });
      currentActiveGroupMembers.set(gId, activePids);
    });

    const updatedNodes = masterData.nodes.map(node => {
      const lc = masterData.nLifecycles.get(node.id);
      const isSpawned = lc && lc.spawnAt <= currentIndex;
      const isFocused = currentEvt && isEventVisible && (node.id === curNormSource || node.id === curNormTarget);
      const isAnonymousNode = node.data.isAnonymousNode;
      const matchesSearch = searchQuery === "" || (node.data.rawName && node.data.rawName.toLowerCase().includes(q)) || node.id.toLowerCase().includes(q);
      const hasVisibleActivity = filteredEvents.some(
        e => getEffectiveId(getNormId(e.source)) === node.id || getEffectiveId(getNormId(e.target)) === node.id
      );

      // 【追加】システム常駐ノード判定 (:group, :code_server, :erlang 等)
      const isSystemProcessNode = [":group", ":code_server", ":erlang", ":standard_error", ":user"].includes(node.data.rawName);

      let currentState = "No state yet";
      if (lc && lc.history) {
        const pastStates = lc.history.filter(h => h.index <= currentIndex);
        if (pastStates.length > 0) currentState = pastStates[pastStates.length - 1].state;
      }

      let newStyle = { ...node.style, opacity: 1, boxShadow: 'none' };
      let isDead = false;
      let displayLabel = node.data.label;
      let poolSpawnedCount = 0;

      const exitReason = lc?.exitReason || '';
      const isNormalExit = [':normal', ':shutdown', 'normal', 'shutdown'].includes(exitReason);

      const gId = pidToGroupId.get(node.id);
      const activeMembersInPool = gId ? currentActiveGroupMembers.get(gId) : null;
      const isCurrentlyPooledWorker = isGroupMode && activeMembersInPool && activeMembersInPool.size >= 2 && !isPoolCollapsed(gId);

      if (node.data.isPool) {
        const members = groupMembers.get(node.id) ? Array.from(groupMembers.get(node.id)) : [];
        let aliveCount = 0;

        members.forEach(pid => {
          const pLc = masterData.nLifecycles.get(pid);
          if (pLc && pLc.spawnAt <= currentIndex) {
            poolSpawnedCount++;
            if (pLc.exitAt > currentIndex) aliveCount++;
          }
        });

        const isAllDead = poolSpawnedCount > 0 && aliveCount === 0;
        isDead = isAllDead;
        const sig = groupInfo.get(node.id)?.sig || 'Worker';
        displayLabel = `Pool: ${sig}\n(${aliveCount}/${poolSpawnedCount} alive)`;

        if (poolSpawnedCount === 0) {
          newStyle.opacity = 0;
        } else if (isAllDead) {
          newStyle.backgroundColor = '#333333';
          newStyle.color = '#aaaaaa';
          newStyle.opacity = 0.5;
          newStyle.borderStyle = 'dashed';
          newStyle.borderColor = '#777';
        } else {
          newStyle.opacity = 1;
          if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.3;
        }
      } else if (isCurrentlyPooledWorker) {
        isDead = lc && lc.exitAt <= currentIndex;
        const isCrash = isDead && !isNormalExit;

        displayLabel = (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <span style={{ 
              position: 'absolute', top: '18px', left: '14px', fontSize: '9px', fontFamily: 'monospace', 
              color: isCrash ? '#ef4444' : '#64748b', whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none'
            }}>
              {node.data.rawId}
            </span>
          </div>
        );
        newStyle = { 
          width: 20, height: 20, borderRadius: '50%', boxSizing: 'border-box', padding: 0,
          backgroundColor: isDead ? (isCrash ? '#4a1515' : '#333333') : '#e2e8f0', 
          borderStyle: isDead ? (isCrash ? 'solid' : 'dashed') : 'solid', 
          borderWidth: '2px',
          borderColor: isDead ? (isCrash ? '#ef4444' : '#777') : '#64748b', 
          opacity: (!isSpawned) ? 0 : (isDead ? (isCrash ? 0.7 : 0.5) : (currentEvt && !isFocused && !isFocusReleased ? 0.3 : 1)),
          transition: 'all 0.3s ease' 
        };
      } else {
        isDead = lc && lc.exitAt <= currentIndex;
        const isCrash = isDead && !isNormalExit;
        
        if (!isSpawned) newStyle.opacity = 0; 
        else if (isDead) { 
          newStyle.backgroundColor = isCrash ? '#4a1515' : '#333333'; 
          newStyle.color = isCrash ? '#fca5a5' : '#aaaaaa'; 
          newStyle.opacity = isCrash ? 0.8 : 0.5; 
          newStyle.borderStyle = isCrash ? 'solid' : 'dashed'; 
          newStyle.borderColor = isCrash ? '#ef4444' : '#777'; 
        }
        else if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.3;
      }

      if (!matchesSearch && searchQuery !== "") newStyle.opacity = 0.05;

      if (isSpawned && isFocused) {
        const eventColor = getEventColor(currentEvt.type, currentEvt.payload);
        newStyle.opacity = 1; 
        newStyle.borderColor = eventColor; 
        newStyle.boxShadow = `0 0 15px ${eventColor}`;
        if (!node.data.isPool && !isAnonymousNode && !isCurrentlyPooledWorker) newStyle.backgroundColor = 'white';
      }
      
      const isHidden = node.data.isPool 
        ? (poolSpawnedCount === 0) 
        : (!isSpawned || (hideAnonymous && isAnonymousNode) || !hasVisibleActivity);

      return { 
        ...node, 
        data: { ...node.data, label: displayLabel, currentState, isDead }, 
        style: newStyle, 
        hidden: isHidden 
      };    
    });

    const groupBoundingNodes = [];
    currentActiveGroupMembers.forEach((activePids, gId) => {
      if (isGroupMode && !isPoolCollapsed(gId) && activePids.size >= 2) {
        const spawnedMembers = updatedNodes.filter(n => activePids.has(n.id) && !n.hidden);
        if (spawnedMembers.length >= 2) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          
          spawnedMembers.forEach(n => {
            const w = parseInt(n.style?.width || nodeWidth, 10);
            const h = parseInt(n.style?.height || nodeHeight, 10);
            minX = Math.min(minX, n.position.x);
            minY = Math.min(minY, n.position.y);
            maxX = Math.max(maxX, n.position.x + w);
            maxY = Math.max(maxY, n.position.y + h);
          });
          
          const padX = 30, padY = 25;
          const sig = groupInfo.get(gId)?.sig || 'Worker';
          
          groupBoundingNodes.push({
            id: `box-${gId}`, 
            targetPosition: 'top', 
            sourcePosition: 'bottom',
            data: { 
              isGroupBoundingBox: true, 
              groupId: gId, 
              label: (
                <div className="pool-group-header" onClick={(e) => { e.stopPropagation(); togglePoolCollapse(gId); }}>
                  <span>▼ {sig} ({spawnedMembers.length})</span>
                  <span style={{ fontSize: '9px', opacity: 0.7 }}>[畳む]</span>
                </div>
              ) 
            },
            position: { x: minX - padX, y: minY - padY }, 
            style: { width: maxX - minX + padX * 2, height: maxY - minY + padY * 2, zIndex: -1 },
            className: 'pool-group-node', 
            draggable: false, 
            selectable: false
          });
        }
      }
    });

    const getEndpointId = (rawId) => {
      if (!isGroupMode) return rawId;
      const gId = pidToGroupId.get(rawId);
      if (!gId || (groupCounts.get(gId) || 0) < 2) return rawId;
      if (isPoolCollapsed(gId)) return gId;
      const activeMembers = currentActiveGroupMembers.get(gId);
      if (activeMembers && activeMembers.size >= 2) return `box-${gId}`;
      return rawId;
    };

    const aggregatedEdgesMap = new Map();
    masterData.edges.forEach(edge => {
      const aggSource = getEndpointId(edge.source); 
      const aggTarget = getEndpointId(edge.target);
      if (aggSource === aggTarget) return;

      const aggEdgeId = `e-${aggSource}-${aggTarget}`;
      const lc = masterData.eLifecycles.get(edge.id);
      
      if (!aggregatedEdgesMap.has(aggEdgeId)) {
        aggregatedEdgesMap.set(aggEdgeId, {
          id: aggEdgeId, 
          source: aggSource, 
          target: aggTarget, 
          types: new Set(edge.data.types), 
          history: lc?.history ? [...lc.history] : [], 
          spawnAt: lc?.spawnAt ?? 0 
        });
      } else {
        const existing = aggregatedEdgesMap.get(aggEdgeId);
        edge.data.types.forEach(t => existing.types.add(t));
        if (lc?.history) existing.history.push(...lc.history);
        existing.spawnAt = Math.min(existing.spawnAt, lc?.spawnAt ?? 0);
      }
    });

    const updatedEdges = Array.from(aggregatedEdgesMap.values()).map(aggEdge => {
      const isSpawned = aggEdge.spawnAt <= currentIndex;
      const pastEvents = aggEdge.history.filter(h => h.index <= currentIndex).sort((a, b) => a.index - b.index);

      let currentPayload = "No data yet";
      let latestType = "UNKNOWN";
      let isLatestSystem = false;
      
      if (pastEvents.length > 0) {
        const latest = pastEvents[pastEvents.length - 1];
        currentPayload = latest.payload;
        latestType = latest.type;
        isLatestSystem = latest.is_system;
      }

      const isTargetSourceMatch = curNormSource === aggEdge.source || getEndpointId(curNormSource) === aggEdge.source;
      const isTargetTargetMatch = curNormTarget === aggEdge.target || getEndpointId(curNormTarget) === aggEdge.target;
      const isFocused = currentEvt && isEventVisible && (isTargetSourceMatch && isTargetTargetMatch);

      let edgeBaseColor = '#aaaaaa';
      if (aggEdge.types.has('SEND') && visibleEvents['SEND']) edgeBaseColor = getEventColor('SEND', currentPayload);
      else if (aggEdge.types.has('RECEIVE') && visibleEvents['RECEIVE']) edgeBaseColor = getEventColor('RECEIVE', currentPayload);
      else if (aggEdge.types.has('SPAWN') && visibleEvents['SPAWN']) edgeBaseColor = getEventColor('SPAWN', currentPayload);

      let newStyle = { stroke: edgeBaseColor, opacity: 1, strokeWidth: 2, transition: 'all 0.3s ease' };
      
      if (!isSpawned) newStyle.opacity = 0;
      else if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.2;

      if (isSpawned && isFocused) {
        newStyle.stroke = getEventColor(currentEvt.type, currentEvt.payload); 
        newStyle.strokeWidth = 4;
      }

      let latestCategory = "app";
      if (pastEvents.length > 0) {
        currentPayload = pastEvents[pastEvents.length - 1].payload;
        latestType = pastEvents[pastEvents.length - 1].type;
        latestCategory = pastEvents[pastEvents.length - 1].category || "app"; // ← 直近のカテゴリを取得
      }

      const hasVisibleType = Array.from(aggEdge.types).some(t => visibleEvents[t]);
      const isCategoryVisible = visibleCategories ? !!visibleCategories[latestCategory] : true;
      const hiddenByFilter = !isCategoryVisible || !hasVisibleType;
      const signature = extractSignature(currentPayload);

      return { 
        id: aggEdge.id, 
        source: aggEdge.source, 
        target: aggEdge.target, 
        data: { types: aggEdge.types, currentPayload, latestType, signature }, 
        style: newStyle, 
        animated: (isSpawned && isFocused), 
        zIndex: (isSpawned && isFocused) ? 1000 : 0, 
        hidden: !isSpawned || hiddenByFilter,
        label: (isSpawned && !hiddenByFilter && currentPayload !== "No data yet" && showEdgeLabels) ? signature : undefined,
        labelStyle: { fill: edgeBaseColor, fontWeight: 'bold', fontSize: 10, opacity: newStyle.opacity },
        labelBgStyle: { fill: 'rgba(255, 255, 255, 0.8)', stroke: edgeBaseColor, strokeWidth: 1, rx: 4, ry: 4, opacity: newStyle.opacity }, 
        labelShowBg: true
      };   
    });

    setRfNodes([...groupBoundingNodes, ...updatedNodes]); 
    setRfEdges(updatedEdges);
  }, [
    currentIndex, masterData, events, isFocusReleased, getNormId, searchQuery, 
    visibleCategories, // ← hideSystemMessages から差し替え
    hideAnonymous, visibleEvents, groupCounts, groupInfo, 
    showEdgeLabels, getEffectiveId, groupMembers, isPoolCollapsed, isGroupMode,
    togglePoolCollapse
  ]);

  return {
    rfNodes, setRfNodes,
    rfEdges, setRfEdges,
    masterData,
    filteredEvents,
    getNormId,
    getFinalName,
    getEffectiveId,
    togglePoolCollapse
  };
}