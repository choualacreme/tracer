import { useEffect, useState, useCallback, useRef } from 'react';
import { Socket } from 'phoenix';
import { ReactFlow, Background, Controls, applyNodeChanges, applyEdgeChanges, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './App.css';

import { formatTime } from './utils';
import { useTraceGraph } from './hooks/useTraceGraph';
import TraceTooltip from './components/TraceTooltip';
import LogPanel from './components/LogPanel';

function TraceViewer() {
  const { fitView, setCenter, getZoom } = useReactFlow();

  // 基本ステート
  const [events, setEvents] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLive, setIsLive] = useState(true);
  const isLiveRef = useRef(true); 
  const [isPlaying, setIsPlaying] = useState(false); 
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [autoFocus, setAutoFocus] = useState(true);
  const isProgrammaticMove = useRef(false);

  // UI・フィルターステート
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('logs');
  const [tooltip, setTooltip] = useState(null); 
  const [isFocusReleased, setIsFocusReleased] = useState(false);
  
  const [searchQuery, setSearchQuery] = useState("");
  const [hideAnonymous, setHideAnonymous] = useState(false);
  const [visibleEvents, setVisibleEvents] = useState({ 'SPAWN': true, 'SEND': true, 'RECEIVE': true, 'EXIT': true, 'LOCAL EVENT': true });
  const [showEdgeLabels, setShowEdgeLabels] = useState(false); 

  const [isGroupMode, setIsGroupMode] = useState(false);
  const [collapsedPools, setCollapsedPools] = useState(new Set());

  const [visibleCategories, setVisibleCategories] = useState({
    app: true,
    otp: true,
    system: false,
    timer: false
  });

  // ==========================================
  // カスタムフックによるグラフデータとフィルタリング計算
  // ==========================================
  const {
    rfNodes, setRfNodes,
    rfEdges, setRfEdges,
    masterData,
    filteredEvents,
    getNormId,
    getFinalName,
    getEffectiveId,
    togglePoolCollapse
  } = useTraceGraph({
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
  });

  // ==========================================
  // WebSocket コネクション
  // ==========================================
  useEffect(() => {
    const wsHost = window.location.hostname === 'localhost' ? 'ws://localhost:4000/socket' : `wss://${window.location.host}/socket`;
    const socket = new Socket(wsHost, { params: {} });
    socket.connect();
    
    const ch = socket.channel("trace_events:lobby", {});
    ch.join();
    
    ch.on("new_trace_event", payload => {
      setEvents(prev => {
        let pt = payload.hlc_pt;
        let c = payload.hlc_c;

        if (pt === undefined && payload.clock) {
          const parts = payload.clock.split('-');
          pt = parseInt(parts[0], 10);
          c = parseInt(parts[1], 10);
        }

        // category を安全に文字列化し、未定義時のみ "app" にする
        const rawCat = payload.category;
        const normalizedCategory = (rawCat && typeof rawCat === 'string') 
          ? rawCat.toLowerCase() 
          : (rawCat ? String(rawCat).toLowerCase() : "app");

        const evt = { 
          ...payload, 
          timestamp: pt || Date.now(), 
          logicalCounter: c || 0,
          category: normalizedCategory
        };
        
        const newEvents = [...prev, evt].sort((a, b) => 
          a.timestamp === b.timestamp ? a.logicalCounter - b.logicalCounter : a.timestamp - b.timestamp
        );
        
        if (isLiveRef.current) { 
          setCurrentIndex(newEvents.length - 1); 
          setCurrentTime(newEvents[newEvents.length - 1].timestamp); 
        }
        return newEvents;
      });
    });
    
    return () => { ch.leave(); socket.disconnect(); };
  }, []);

  // ==========================================
  // ナビゲーション・カメラ追従ロジック
  // ==========================================
  const focusOnEvent = useCallback((evt) => {
    if (!isLiveRef.current || !autoFocus || !evt || masterData.nodes.length === 0) return;
    
    let targetX = 0, targetY = 0, validNodesCount = 0;
    const addNodeCoord = (id) => { 
      const node = masterData.nodes.find(n => n.id === id); 
      if (node) { 
        targetX += node.position.x + 75; 
        targetY += node.position.y + 20; 
        validNodesCount++; 
      } 
    };
    
    addNodeCoord(getEffectiveId(getNormId(evt.source))); 
    addNodeCoord(getEffectiveId(getNormId(evt.target)));
    
    if (validNodesCount > 0) { 
      isProgrammaticMove.current = true; 
      setCenter(targetX / validNodesCount, targetY / validNodesCount, { zoom: getZoom(), duration: 600 }); 
      setTimeout(() => { isProgrammaticMove.current = false; }, 700); 
    }
  }, [masterData.nodes, getNormId, getEffectiveId, getZoom, setCenter, autoFocus]);

  useEffect(() => { 
    if (isLiveRef.current && autoFocus && events[currentIndex]) {
      focusOnEvent(events[currentIndex]); 
    }
  }, [currentIndex, events, focusOnEvent, autoFocus]);

  // テーブルの自動スクロール
  useEffect(() => {
    if (currentIndex >= 0 && activeTab === 'logs') {
      const row = document.getElementById(`log-row-${currentIndex}`);
      const container = document.getElementById('log-table-container');
      if (row && container) {
        container.scrollTo({ top: row.offsetTop - (container.clientHeight / 2) + (row.clientHeight / 2), behavior: 'smooth' });
      }
    }
  }, [currentIndex, activeTab]);

  const jumpToIndex = useCallback((idx) => { 
    setCurrentIndex(idx); 
    if (events[idx]) setCurrentTime(events[idx].timestamp); 
    setIsFocusReleased(false); 
    if (isLive) { setIsLive(false); isLiveRef.current = false; } 
  }, [events, isLive]);

  const jumpToPrev = useCallback(() => { 
    const currentFIdx = filteredEvents.findIndex(e => e.originalIndex === currentIndex); 
    if (currentFIdx > 0) jumpToIndex(filteredEvents[currentFIdx - 1].originalIndex); 
    else if (currentFIdx === -1 && filteredEvents.length > 0) { 
      const prev = [...filteredEvents].reverse().find(e => e.originalIndex < currentIndex); 
      if (prev) jumpToIndex(prev.originalIndex); 
    } 
  }, [filteredEvents, currentIndex, jumpToIndex]);

  const jumpToNext = useCallback(() => { 
    const currentFIdx = filteredEvents.findIndex(e => e.originalIndex === currentIndex); 
    if (currentFIdx >= 0 && currentFIdx < filteredEvents.length - 1) jumpToIndex(filteredEvents[currentFIdx + 1].originalIndex); 
    else if (currentFIdx === -1 && filteredEvents.length > 0) { 
      const next = filteredEvents.find(e => e.originalIndex > currentIndex); 
      if (next) jumpToIndex(next.originalIndex); 
    } 
  }, [filteredEvents, currentIndex, jumpToIndex]);

  const resetFilters = useCallback(() => { 
    setSearchQuery(""); 
    setVisibleCategories({ app: true, otp: true, system: false, timer: false }); // ← 更新
    setHideAnonymous(false); 
    setVisibleEvents({ 'SPAWN': true, 'SEND': true, 'RECEIVE': true, 'EXIT': true, 'LOCAL EVENT': true }); 
    setIsFocusReleased(true); 
  }, []);

  // 再生ロジック
  useEffect(() => {
    if (isPlaying && !isLive && currentIndex < events.length - 1) {
      const timer = setTimeout(
        () => jumpToNext(), 
        Math.min(Math.max(events[currentIndex + 1].timestamp - events[currentIndex].timestamp, 50), 2000) / playbackSpeed
      );
      return () => clearTimeout(timer);
    } else if (isPlaying && currentIndex >= events.length - 1) {
      setIsPlaying(false);
    }
  }, [isPlaying, isLive, currentIndex, events, jumpToNext, playbackSpeed]);

  const timeRange = (events.length > 0 ? events[events.length - 1].timestamp : 0) - (events.length > 0 ? events[0].timestamp : 0) || 1;

  // ==========================================
  // レンダリング
  // ==========================================
  return (
    <div className="app-container">
      <h2 className="app-title">Actor Model Trace Viewer</h2>
      
      {/* ヘッダー操作パネル */}
      <div className="header-controls">        
        <button onClick={() => { setEvents([]); setCurrentIndex(-1); setCurrentTime(0); setIsLive(true); isLiveRef.current = true; setIsPlaying(false); setCollapsedPools(new Set()); }} className="btn-clear">
          ログ・グラフをクリア
        </button>
        <button onClick={() => { const next = !isLive; setIsLive(next); isLiveRef.current = next; setIsPlaying(false); if(next && events.length > 0){ setCurrentIndex(events.length - 1); setCurrentTime(events[events.length - 1].timestamp); } }} className={`btn-base ${isLive ? 'btn-live-active' : 'btn-live-paused'}`}>
          {isLive ? '🔴 LIVE (自動追従中)' : '⏸ LIVEを再開'}
        </button>
        {!isLive && (
          <div className="speed-control-box">
            <button onClick={() => setIsPlaying(!isPlaying)} className={`btn-base ${isPlaying ? 'btn-replay-active' : 'btn-replay-idle'}`}>
              {isPlaying ? '⏸ 一時停止' : '▶ REPLAY再生'}
            </button>
            <select value={playbackSpeed} onChange={e => setPlaybackSpeed(Number(e.target.value))} className="speed-select">
              <option value={0.5}>x0.5</option>
              <option value={1.0}>x1.0</option>
              <option value={2.0}>x2.0</option>
              <option value={5.0}>x5.0</option>
            </select>
          </div>
        )}
        {isLive && (
          <button onClick={() => setAutoFocus(!autoFocus)} className={`btn-base ${autoFocus ? 'btn-focus-on' : 'btn-focus-off'}`}>
            {autoFocus ? '📷 カメラ追従: ON' : '📷 カメラ追従: OFF'}
          </button>
        )}
        <button onClick={() => setShowEdgeLabels(!showEdgeLabels)} className={`btn-base ${showEdgeLabels ? 'btn-label-on' : 'btn-label-off'}`}>
          {showEdgeLabels ? '🏷 ラベル: ON' : '🏷 ラベル: OFF'}
        </button>
      </div>

      {/* タイムライン */}
      <div className="timeline-card">
        <button onClick={() => { setIsPlaying(false); jumpToPrev(); }} disabled={currentIndex <= 0} className="timeline-step-btn">◀</button>
        <div className="timeline-track-wrap">
          <span className="timeline-label">Real-time</span>
          <div className="timeline-bar-container">
            <div className="timeline-pins-overlay">
              {(() => { 
                const step = Math.max(1, Math.floor(filteredEvents.length / 200)); 
                return filteredEvents.filter((_, i) => i % step === 0).map((evt) => (
                  <div key={`time-hl-${evt.originalIndex}`} className="timeline-pin" style={{ left: `${((evt.timestamp - (events[0]?.timestamp || 0)) / timeRange) * 100}%` }} />
                )); 
              })()}
            </div>
            <input 
              type="range" min={events[0]?.timestamp || 0} max={events[events.length - 1]?.timestamp || 0} value={currentTime} 
              onChange={(e) => { 
                const t = Number(e.target.value); setCurrentTime(t); setIsFocusReleased(false); setIsPlaying(false); 
                if(isLive){ setIsLive(false); isLiveRef.current = false; } 
                let n = -1; for(let i = events.length - 1; i >= 0; i--){ if(events[i].timestamp <= t){ n = i; break; } } 
                setCurrentIndex(n); 
              }} 
              className="timeline-range-input" disabled={events.length === 0} 
            />
          </div>
          <span className="timeline-clock">{formatTime(currentTime)}</span>
        </div>
        <button onClick={() => { setIsPlaying(false); jumpToNext(); }} disabled={currentIndex >= events.length - 1} className="timeline-step-btn">▶</button>
      </div>

      {/* キャンバス領域 */}
      <div className="canvas-wrapper">
        <div className="graph-full-container">
          <ReactFlow 
            nodes={rfNodes} edges={rfEdges} minZoom={0.05} 
            onNodesChange={useCallback((changes) => setRfNodes((nds) => applyNodeChanges(changes, nds)), [setRfNodes])} 
            onEdgesChange={useCallback((changes) => setRfEdges((eds) => applyEdgeChanges(changes, eds)), [setRfEdges])} 
            onNodeMouseEnter={useCallback((e, node) => { if (!node.data?.isGroupBoundingBox) setTooltip({ x: e.clientX, y: e.clientY, type: 'node', id: node.id }); }, [])} 
            onNodeMouseLeave={() => setTooltip(null)} 
            onEdgeMouseEnter={useCallback((e, edge) => { setTooltip({ x: e.clientX, y: e.clientY, type: 'edge', id: edge.id }); }, [])} 
            onEdgeMouseLeave={() => setTooltip(null)} 
            onPaneClick={() => { setIsFocusReleased(true); if (isLiveRef.current) setAutoFocus(false); }} 
            onMove={useCallback((event) => { if (isLiveRef.current && event && (event instanceof MouseEvent || event instanceof WheelEvent || (window.TouchEvent && event instanceof TouchEvent))) setAutoFocus(false); }, [])} 
            onNodeClick={useCallback((_, node) => { 
              if (node.data?.isGroupBoundingBox || node.data?.isPool) { 
                togglePoolCollapse(node.data?.isPool ? node.id : node.data.groupId); return; 
              } 
              setIsFocusReleased(false); 
              if(isLiveRef.current){ setIsLive(false); isLiveRef.current = false; } 
              for(let i = events.length - 1; i >= 0; i--){ 
                if(getEffectiveId(getNormId(events[i].source)) === node.id || getEffectiveId(getNormId(events[i].target)) === node.id){ 
                  jumpToIndex(i); break; 
                } 
              } 
            }, [events, getNormId, getEffectiveId, jumpToIndex, togglePoolCollapse])} 
            onEdgeClick={useCallback((_, edge) => { 
              setIsFocusReleased(false); 
              if(isLiveRef.current){ setIsLive(false); isLiveRef.current = false; } 
              const lc = masterData.eLifecycles.get(edge.id); 
              if (lc && lc.history) { 
                const past = lc.history.filter(h => h.index <= currentIndex); 
                if(past.length > 0) jumpToIndex(past[past.length - 1].index); 
              } 
            }, [currentIndex, masterData, jumpToIndex])} 
            onNodeDoubleClick={useCallback((_, node) => { 
              if (!node.data?.isGroupBoundingBox) { 
                setSearchQuery(node.id); setActiveTab('logs'); setIsFocusReleased(true); 
              } 
            }, [])}
          >
            <Background color="#ccc" gap={16} />
            <Controls position="bottom-right" className="custom-controls" />
          </ReactFlow>
        </div>

        {/* 分離した右サイドバーパネル */}
        <LogPanel 
          events={events}
          filteredEvents={filteredEvents}
          currentIndex={currentIndex}
          jumpToIndex={jumpToIndex}
          setIsPlaying={setIsPlaying}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          rfNodes={rfNodes}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          visibleCategories={visibleCategories}
          setVisibleCategories={setVisibleCategories}
          hideAnonymous={hideAnonymous}
          setHideAnonymous={setHideAnonymous}
          isGroupMode={isGroupMode}
          setIsGroupMode={setIsGroupMode}
          visibleEvents={visibleEvents}
          setVisibleEvents={setVisibleEvents}
          resetFilters={resetFilters}
          getNormId={getNormId}
          getFinalName={getFinalName}
          isPanelOpen={isPanelOpen}
          setIsPanelOpen={setIsPanelOpen}
          setIsFocusReleased={setIsFocusReleased}
          setCollapsedPools={setCollapsedPools}
        />
      </div>

      {/* 分離したツールチップ */}
      <TraceTooltip 
        tooltip={tooltip}
        events={events}
        currentIndex={currentIndex}
        masterData={masterData}
        rfEdges={rfEdges}
        getEffectiveId={getEffectiveId}
        getNormId={getNormId}
        getFinalName={getFinalName}
      />
    </div>
  );
}

export default function App() { 
  return (
    <ReactFlowProvider>
      <TraceViewer />
    </ReactFlowProvider>
  ); 
}