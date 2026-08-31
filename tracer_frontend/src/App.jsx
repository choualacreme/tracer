import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Socket } from 'phoenix'
import { 
  ReactFlow, Background, Controls, 
  applyNodeChanges, applyEdgeChanges,
  ReactFlowProvider, useReactFlow 
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'

// ==========================================
// 定数・グラフ設定・ヘルパー関数
// ==========================================
const nodeWidth = 150;
const nodeHeight = 40;

const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 40, ranksep: 120, edgesep: 20 });
  
  nodes.forEach((node) => { 
    const w = parseInt(node.style?.width || nodeWidth, 10);
    const h = parseInt(node.style?.height || nodeHeight, 10);
    dagreGraph.setNode(node.id, { width: w, height: h }); 
  });
  edges.forEach((edge) => { dagreGraph.setEdge(edge.source, edge.target); });
  dagre.layout(dagreGraph);

  return {
    nodes: nodes.map((node) => {
      const nodeWithPosition = dagreGraph.node(node.id);
      const w = parseInt(node.style?.width || nodeWidth, 10);
      const h = parseInt(node.style?.height || nodeHeight, 10);
      return {
        ...node, targetPosition: 'top', sourcePosition: 'bottom',
        position: { x: nodeWithPosition.x - w / 2, y: nodeWithPosition.y - h / 2 },
      };
    }),
    edges
  };
};

const getEventColor = (type) => {
  switch (type) {
    case 'SPAWN': return '#4CAF50';
    case 'SEND': return '#569CD6';
    case 'RECEIVE': return '#DCDCAA';
    case 'EXIT': return '#F44747';
    case 'LOCAL EVENT': return '#C586C0';
    default: return '#aaaaaa';
  }
};

const formatTime = (ts) => {
  if (!ts) return "00:00:00.000";
  const d = new Date(ts);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const parseHLC = (clockStr) => {
  if (!clockStr) return { pt: 0, c: 0 };
  const parts = clockStr.split('-');
  return { pt: parseInt(parts[0] || '0', 10), c: parseInt(parts[1] || '0', 10) };
};

const extractSignature = (payload) => {
  if (!payload || payload === 'nil') return 'nil';
  
  // 1. タプル {:hoge, ...} の先頭アトムを抽出
  const tupleMatch = payload.match(/^\{(:[a-zA-Z0-9_]+)/);
  if (tupleMatch) return tupleMatch[1];
  
  // 2. 単一のアトム（例: :timeout, :ok）
  if (payload.startsWith(':')) return payload.split(/[\s,}]/)[0];
  
  // 3. 構造体（例: %Factory.Item{...}）
  const structMatch = payload.match(/^%([a-zA-Z0-9_.]+)/);
  if (structMatch) return `%${structMatch[1]}`;
  
  // それ以外（短い文字列ならそのまま、長ければ切り詰め）
  return payload.length > 12 ? payload.substring(0, 12) + '...' : payload;
};

// ==========================================
// メインコンポーネント (TraceViewer)
// ==========================================
function TraceViewer() {
  const { fitView, setCenter, getZoom } = useReactFlow();

  // --- State: アプリケーションの基本状態 ---
  const [events, setEvents] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLive, setIsLive] = useState(true);
  const isLiveRef = useRef(true); 
  const [isPlaying, setIsPlaying] = useState(false); 
  const [autoFocus, setAutoFocus] = useState(true);

  // --- State: UI・フィルター制御 ---
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('logs');
  const [tooltip, setTooltip] = useState(null);
  const [isFocusReleased, setIsFocusReleased] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [hideSystemMessages, setHideSystemMessages] = useState(false);
  const [hideAnonymous, setHideAnonymous] = useState(false);
  const [visibleEvents, setVisibleEvents] = useState({
    'SPAWN': true, 'SEND': true, 'RECEIVE': true, 'EXIT': true, 'LOCAL EVENT': true
  });

  // --- State: React Flow 描画用 ---
  const [rfNodes, setRfNodes] = useState([]);
  const [rfEdges, setRfEdges] = useState([]);

  // ==========================================
  // データ抽出・正規化
  // ==========================================
  const { nameToPid, pidToName } = useMemo(() => {
    const n2p = new Map(), p2n = new Map();
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

  const getNormId = useCallback((id) => (id && !id.startsWith("#PID") && nameToPid.has(id)) ? nameToPid.get(id) : id, [nameToPid]);
  const getFinalName = useCallback((normId, rawName) => pidToName.get(normId) || rawName, [pidToName]);

  // ==========================================
  // マスターグラフの構築
  // ==========================================
  const masterData = useMemo(() => {
    const allNodesMap = new Map();
    const allEdgesMap = new Map();
    const nLifecycles = new Map();
    const eLifecycles = new Map();

    events.forEach((evt, idx) => {
      const normSource = getNormId(evt.source);
      const normTarget = getNormId(evt.target);
      const finalSourceName = getFinalName(normSource, evt.source_name);
      const finalTargetName = getFinalName(normTarget, evt.target_name);

      const processNode = (id, name) => {
        if (!id || allNodesMap.has(id)) return;
        const isPidString = id.startsWith("#PID");
        const hasRealName = name && name !== "[]" && !name.startsWith("#PID");
        const isAnonymous = !hasRealName && isPidString;
        const displayLabel = hasRealName ? (isPidString ? `${name}\n(${id})` : name) : id;

        allNodesMap.set(id, {
          id: id,
          data: { label: displayLabel, rawName: name },
          position: { x: 0, y: 0 },
          style: isAnonymous 
            ? { width: 20, height: 20, borderRadius: '50%', backgroundColor: '#e0e7ff', borderStyle: 'solid', borderWidth: '2px', borderColor: '#818cf8', transition: 'all 0.3s ease' }
            : { borderStyle: 'solid', borderWidth: '1px', borderColor: '#888', padding: '10px', borderRadius: '5px', backgroundColor: 'white', width: nodeWidth, fontSize: '11px', textAlign: 'center', wordBreak: 'break-all', transition: 'all 0.3s ease', whiteSpace: 'pre-wrap' }
        });
        nLifecycles.set(id, { spawnAt: idx, exitAt: Infinity, history: [] });
      };

      if (normSource) processNode(normSource, finalSourceName);
      if (normTarget) processNode(normTarget, finalTargetName);

      if (evt.type === 'EXIT' && nLifecycles.has(normSource)) nLifecycles.get(normSource).exitAt = idx;
      if (evt.type === 'LOCAL EVENT' && nLifecycles.has(normSource)) nLifecycles.get(normSource).history.push({ index: idx, state: evt.payload });

      if (['SPAWN', 'SEND', 'RECEIVE'].includes(evt.type) && normSource && normTarget) {
        const edgeId = `e-${normSource}-${normTarget}`;
        if (!allEdgesMap.has(edgeId)) {
          allEdgesMap.set(edgeId, {
            id: edgeId, source: normSource, target: normTarget,
            style: { stroke: getEventColor(evt.type), strokeWidth: 2 },
            data: { types: new Set([evt.type]) }
          });
          eLifecycles.set(edgeId, { spawnAt: idx, history: [{ index: idx, payload: evt.payload, type: evt.type }] });
        } else {
          allEdgesMap.get(edgeId).data.types.add(evt.type); 
          eLifecycles.get(edgeId).history.push({ index: idx, payload: evt.payload, type: evt.type });
        }
      }
    });

    const layouted = getLayoutedElements(Array.from(allNodesMap.values()), Array.from(allEdgesMap.values()));
    return { nodes: layouted.nodes, edges: layouted.edges, nLifecycles, eLifecycles };
  }, [events, getNormId, getFinalName]);

  // 初回レイアウト時のカメラ調整
  useEffect(() => {
    if (masterData.nodes.length > 0 && rfNodes.length === 0) {
      setTimeout(() => fitView({ padding: 0.2, duration: 500 }), 50);
    }
  }, [masterData.nodes.length, fitView, rfNodes.length]);

  // ==========================================
  // フィルター判定と履歴抽出
  // ==========================================
  const passesFilters = useCallback((evt) => {
    if (!evt || !visibleEvents[evt.type]) return false;
    if (hideSystemMessages && (evt.payload === "timeout" || (evt.payload || "").startsWith("{:DOWN") || (evt.payload || "").startsWith("{:EXIT"))) return false;
    if (hideAnonymous) {
      const sName = getFinalName(getNormId(evt.source), evt.source_name);
      const tName = getFinalName(getNormId(evt.target), evt.target_name);
      if ((evt.source && (!sName || sName === "[]" || sName.startsWith("#PID"))) || 
          (evt.target && (!tName || tName === "[]" || tName.startsWith("#PID")))) return false;
    }
    if (searchQuery !== "") {
      const q = searchQuery.toLowerCase();
      const sName = (getFinalName(getNormId(evt.source), evt.source_name) || "").toLowerCase();
      const tName = (getFinalName(getNormId(evt.target), evt.target_name) || "").toLowerCase();
      if (!sName.includes(q) && !tName.includes(q) && !(getNormId(evt.source) || "").toLowerCase().includes(q) && !(getNormId(evt.target) || "").toLowerCase().includes(q) && !(evt.payload || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }, [hideSystemMessages, hideAnonymous, searchQuery, visibleEvents, getNormId, getFinalName]);

  const filteredEvents = useMemo(() => events.map((evt, idx) => ({ ...evt, originalIndex: idx })).filter(passesFilters), [events, passesFilters]);

  // ==========================================
  // 描画データの生成と適用
  // ==========================================
  useEffect(() => {
    if (masterData.nodes.length === 0 || currentIndex < 0) {
      setRfNodes([]); setRfEdges([]); return;
    }

    const currentEvt = events[currentIndex];
    const curNormSource = getNormId(currentEvt?.source);
    const curNormTarget = getNormId(currentEvt?.target);
    const q = searchQuery.toLowerCase();
    const isEventVisible = currentEvt && visibleEvents[currentEvt.type];

    const updatedNodes = masterData.nodes.map(node => {
      const lc = masterData.nLifecycles.get(node.id);
      const isSpawned = lc && lc.spawnAt <= currentIndex;
      const isDead = lc && lc.exitAt <= currentIndex;
      const isFocused = currentEvt && isEventVisible && (node.id === curNormSource || node.id === curNormTarget);
      
      const isAnonymousNode = !node.data.rawName || node.data.rawName === "[]" || node.data.rawName.startsWith("#PID");
      const matchesSearch = searchQuery === "" || (node.data.rawName && node.data.rawName.toLowerCase().includes(q)) || node.id.toLowerCase().includes(q);

      let currentState = "No state yet";
      if (lc && lc.history) {
        const pastStates = lc.history.filter(h => h.index <= currentIndex);
        if (pastStates.length > 0) currentState = pastStates[pastStates.length - 1].state;
      }

      let newStyle = { ...node.style, opacity: 1, boxShadow: 'none' };
      if (!isSpawned) newStyle.opacity = 0; 
      else if (isDead) { newStyle.backgroundColor = '#333333'; newStyle.color = '#aaaaaa'; newStyle.opacity = 0.5; newStyle.borderStyle = 'dashed'; newStyle.borderColor = '#777'; }
      else if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.3;
      if (!matchesSearch && searchQuery !== "") newStyle.opacity = 0.05;

      if (isSpawned && isFocused) {
        const eventColor = getEventColor(currentEvt.type);
        newStyle.opacity = 1; newStyle.borderWidth = '3px'; newStyle.borderColor = eventColor; newStyle.boxShadow = `0 0 15px ${eventColor}`;
      }
      
      return { 
        ...node, 
        data: { ...node.data, currentState, isDead },
        style: newStyle, 
        hidden: !isSpawned || (hideAnonymous && isAnonymousNode) 
      };    });

    const updatedEdges = masterData.edges.map(edge => {
      const lc = masterData.eLifecycles.get(edge.id);
      const isSpawned = lc && lc.spawnAt <= currentIndex;
      const isFocused = currentEvt && isEventVisible && (edge.source === curNormSource && edge.target === curNormTarget);
      
      const sourceNode = masterData.nodes.find(n => n.id === edge.source);
      const targetNode = masterData.nodes.find(n => n.id === edge.target);
      const sourceAnon = sourceNode ? (!sourceNode.data.rawName || sourceNode.data.rawName === "[]" || sourceNode.data.rawName.startsWith("#PID")) : false;
      const targetAnon = targetNode ? (!targetNode.data.rawName || targetNode.data.rawName === "[]" || targetNode.data.rawName.startsWith("#PID")) : false;
      const isSysMsg = edge.data.payload === "timeout" || (edge.data.payload || "").startsWith("{:DOWN") || (edge.data.payload || "").startsWith("{:EXIT");

      let currentPayload = "No data yet", latestType = "UNKNOWN";

      if (lc && lc.history) {
        const pastEvents = lc.history.filter(h => h.index <= currentIndex);
        if (pastEvents.length > 0) {
          const last = pastEvents[pastEvents.length - 1];
          currentPayload = last.payload; latestType = last.type;
        }
      }

      let edgeBaseColor = '#aaaaaa';
      if (edge.data.types.has('SEND') && visibleEvents['SEND']) edgeBaseColor = getEventColor('SEND');
      else if (edge.data.types.has('RECEIVE') && visibleEvents['RECEIVE']) edgeBaseColor = getEventColor('RECEIVE');
      else if (edge.data.types.has('SPAWN') && visibleEvents['SPAWN']) edgeBaseColor = getEventColor('SPAWN');

      let newStyle = { ...edge.style, stroke: edgeBaseColor, opacity: 1, strokeWidth: 2 };
      let animated = false, zIndex = 0;

      if (!isSpawned) newStyle.opacity = 0;
      else if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.2;
      
      if (searchQuery !== "") {
        const payloadMatches = (edge.data.payload || "").toLowerCase().includes(q);
        const sourceMatches = sourceNode && ((sourceNode.data.rawName || "").toLowerCase().includes(q) || sourceNode.id.toLowerCase().includes(q));
        const targetMatches = targetNode && ((targetNode.data.rawName || "").toLowerCase().includes(q) || targetNode.id.toLowerCase().includes(q));
        if (!payloadMatches && !sourceMatches && !targetMatches) newStyle.opacity = 0.02;
      }

      if (isSpawned && isFocused) {
        newStyle.stroke = getEventColor(currentEvt.type); newStyle.strokeWidth = 4; animated = true; zIndex = 1000;
      }

      const hasVisibleType = Array.from(edge.data.types).some(t => visibleEvents[t]);
      const hiddenByFilter = (hideSystemMessages && isSysMsg) || (hideAnonymous && (sourceAnon || targetAnon)) || !hasVisibleType;
      
      const signature = extractSignature(currentPayload);
      const labelStyle = { fill: edgeBaseColor, fontWeight: 'bold', fontSize: 10, opacity: newStyle.opacity };
      const labelBgStyle = { fill: 'rgba(255, 255, 255, 0.8)', stroke: edgeBaseColor, strokeWidth: 1, rx: 4, ry: 4, opacity: newStyle.opacity };

      return { 
        ...edge, 
        data: { ...edge.data, currentPayload, latestType, signature }, 
        style: newStyle, animated, zIndex, hidden: !isSpawned || hiddenByFilter,
        label: (isSpawned && !hiddenByFilter && currentPayload !== "No data yet") ? signature : undefined,
        labelStyle,
        labelBgStyle,
        labelShowBg: true
      };    
    });

    setRfNodes(updatedNodes);
    setRfEdges(updatedEdges);
  }, [currentIndex, masterData, events, isFocusReleased, getNormId, searchQuery, hideSystemMessages, hideAnonymous, visibleEvents]);

  // ==========================================
  // 通信・ナビゲーション・イベントハンドラ
  // ==========================================
  useEffect(() => {
    const socket = new Socket("ws://localhost:4000/socket", { params: {} });
    socket.connect();
    const ch = socket.channel("trace_events:lobby", {});
    ch.join();
    ch.on("new_trace_event", payload => {
      setEvents(prev => {
        const hlc = parseHLC(payload.clock);
        const evt = { ...payload, timestamp: hlc.pt, logicalCounter: hlc.c };
        const newEvents = [...prev, evt].sort((a, b) => a.timestamp === b.timestamp ? a.logicalCounter - b.logicalCounter : a.timestamp - b.timestamp);
        if (isLiveRef.current) {
          setCurrentIndex(newEvents.length - 1);
          setCurrentTime(newEvents[newEvents.length - 1].timestamp);
        }
        return newEvents;
      });
    });
    return () => { ch.leave(); socket.disconnect(); };
  }, []);

  const focusOnEvent = useCallback((evt) => {
    if (!evt || masterData.nodes.length === 0) return;
    let targetX = 0, targetY = 0, validNodesCount = 0;
    const addNodeCoord = (id) => {
      const node = masterData.nodes.find(n => n.id === id);
      if (node) { targetX += node.position.x + 75; targetY += node.position.y + 20; validNodesCount++; }
    };
    addNodeCoord(getNormId(evt.source)); addNodeCoord(getNormId(evt.target));
    if (validNodesCount > 0) setCenter(targetX / validNodesCount, targetY / validNodesCount, { zoom: getZoom(), duration: 600 });
  }, [masterData.nodes, getNormId, getZoom, setCenter]);

  useEffect(() => { if (isLiveRef.current && events[currentIndex]) focusOnEvent(events[currentIndex]); }, [currentIndex, events, focusOnEvent]);

  const jumpToIndex = useCallback((idx) => {
    setCurrentIndex(idx);
    if (events[idx]) { 
      setCurrentTime(events[idx].timestamp); 
      if (autoFocus) focusOnEvent(events[idx]); 
    }
    setIsFocusReleased(false);
    if (isLive) { setIsLive(false); isLiveRef.current = false; }
  }, [events, focusOnEvent, isLive, autoFocus]);

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
    setSearchQuery(""); setHideSystemMessages(false); setHideAnonymous(false);
    setVisibleEvents({ 'SPAWN': true, 'SEND': true, 'RECEIVE': true, 'EXIT': true, 'LOCAL EVENT': true });
    setIsFocusReleased(true);
  }, []);

  // ツールチップ
  const onNodeMouseEnter = useCallback((e, node) => {
    let lastEvtType = 'NONE';
    let parentId = '-';
    let parentName = null;
    let sendCount = 0, receiveCount = 0, spawnCount = 0, localCount = 0;

    for (let i = 0; i <= currentIndex; i++) {
      const ev = events[i];
      if (!ev) continue;

      const isSource = getNormId(ev.source) === node.id;
      const isTarget = getNormId(ev.target) === node.id;

      if (ev.type === 'SPAWN') {
        if (isTarget) {
          parentId = getNormId(ev.source);
          parentName = getFinalName(parentId, ev.source_name);
        }
        if (isSource) spawnCount++;
      }
      if (ev.type === 'SEND' && isSource) sendCount++;
      if (ev.type === 'RECEIVE' && isTarget) receiveCount++;
      if (ev.type === 'LOCAL EVENT' && isSource) localCount++;

      if (isSource || isTarget) lastEvtType = ev.type;
    }

    const displayState = (node.data.currentState || 'N/A').length > 200 ? (node.data.currentState || 'N/A').substring(0, 200) + ' ... ' : (node.data.currentState || 'N/A');
    
    setTooltip({ 
      x: e.clientX, y: e.clientY, isNode: true,
      title: node.data.rawName || 'Anonymous', 
      titleColor: getEventColor(lastEvtType), 
      pid: node.id, 
      parentId, parentName, sendCount, receiveCount, spawnCount, localCount,
      lastEvtType, state: displayState 
    });
  }, [currentIndex, events, getNormId, getFinalName]);

  const onEdgeMouseEnter = useCallback((e, edge) => {
    const typesArr = edge.data?.types ? Array.from(edge.data.types) : ['UNKNOWN'];
    const displayPayload = (edge.data?.currentPayload || 'nil').length > 100 ? (edge.data?.currentPayload || 'nil').substring(0, 100) + ' ...' : (edge.data?.currentPayload || 'nil');
    
    setTooltip({ 
      x: e.clientX, y: e.clientY, isNode: false,
      types: typesArr, lType: edge.data?.latestType || 'UNKNOWN',
      source: edge.source, target: edge.target, payload: displayPayload
    });
  }, []);

  // REPLAYモード中の自動再生
  useEffect(() => {
    if (isPlaying && !isLive) {
      const timer = setTimeout(() => {
        jumpToNext();
      }, 800); // ★再生スピード（ミリ秒）。好みに合わせて調整してください
      return () => clearTimeout(timer);
    }
  }, [isPlaying, isLive, currentIndex, filteredEvents, jumpToNext]);

  // ==========================================
  // JSX描画
  // ==========================================
  const renderProcess = useCallback((id, name) => {
    if (!id) return '-';
    if (name && name !== "[]" && !name.startsWith("#PID")) return (<div style={{ lineHeight: '1.2' }}><div style={{ fontWeight: 'bold' }}>{name}</div>{id.startsWith("#PID") && <div style={{ fontSize: '9.5px', color: '#888', fontFamily: 'monospace' }}>{id}</div>}</div>);
    return <span style={{ fontFamily: 'monospace', color: '#bbb' }}>{id}</span>;
  }, []);

  const timeRange = (events.length > 0 ? events[events.length - 1].timestamp : 0) - (events.length > 0 ? events[0].timestamp : 0) || 1;

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', height: '100vh', boxSizing: 'border-box' }}>
      <h2>Actor Model Trace Viewer</h2>
      <div style={{ marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center' }}>        
        <button onClick={() => { setEvents([]); setCurrentIndex(-1); setCurrentTime(0); setIsLive(true); isLiveRef.current = true; setIsPlaying(false); }} style={{ padding: '6px 12px', cursor: 'pointer' }}>ログ・グラフをクリア</button>
        <button onClick={() => { const next = !isLive; setIsLive(next); isLiveRef.current = next; setIsPlaying(false); if(next && events.length > 0){ setCurrentIndex(events.length - 1); setCurrentTime(events[events.length - 1].timestamp); } }} style={{ padding: '6px 12px', cursor: 'pointer', backgroundColor: isLive ? '#4CAF50' : '#f44336', color: 'white', border: 'none', borderRadius: '4px'}}>
          {isLive ? '🔴 LIVE (自動追従中)' : '⏸ LIVEを再開'}
        </button>
        {!isLive && (
          <button onClick={() => setIsPlaying(!isPlaying)} style={{ padding: '6px 12px', cursor: 'pointer', backgroundColor: isPlaying ? '#2196F3' : '#607D8B', color: 'white', border: 'none', borderRadius: '4px' }}>
            {isPlaying ? '⏸ 一時停止' : '▶ REPLAY再生'}
          </button>
        )}
        <button onClick={() => setAutoFocus(!autoFocus)} style={{ padding: '6px 12px', cursor: 'pointer', backgroundColor: autoFocus ? '#FF9800' : '#9E9E9E', color: 'white', border: 'none', borderRadius: '4px' }}>
          {autoFocus ? '📷 カメラ追従: ON' : '📷 カメラ追従: OFF'}
        </button>
      </div>

      <div style={{ marginBottom: '16px', padding: '15px', backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '15px' }}>
        <button onClick={() => { setIsPlaying(false); jumpToPrev(); }} disabled={currentIndex <= 0} style={{ cursor: currentIndex <= 0 ? 'not-allowed' : 'pointer', padding: '0 15px' }}>◀</button>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '12px', width: '65px', color: '#666', fontWeight: 'bold' }}>Real-time</span>
          <div style={{ position: 'relative', flex: 1, height: '16px', display: 'flex', alignItems: 'center' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, pointerEvents: 'none', zIndex: 1 }}>
              {(() => {
                const maxPins = 200;
                const step = Math.max(1, Math.floor(filteredEvents.length / maxPins));
                return filteredEvents.filter((_, i) => i % step === 0).map((evt) => (
                  <div key={`time-hl-${evt.originalIndex}`} style={{ position: 'absolute', left: `${((evt.timestamp - (events[0]?.timestamp || 0)) / timeRange) * 100}%`, top: '2px', width: '2px', height: '12px', backgroundColor: getEventColor(evt.type), transform: 'translateX(-50%)', opacity: 0.6 }} />
                ));
              })()}
            </div>
            <input 
              type="range" min={events[0]?.timestamp || 0} max={events[events.length - 1]?.timestamp || 0} value={currentTime} 
              onChange={(e) => { 
                const t = Number(e.target.value); 
                setCurrentTime(t); 
                setIsFocusReleased(false); 
                setIsPlaying(false);
                if(isLive){ setIsLive(false); isLiveRef.current = false; } 
                let n = -1; 
                for(let i = events.length - 1; i >= 0; i--){ if(events[i].timestamp <= t){ n = i; break; } } 
                setCurrentIndex(n); 
              }} 
              style={{ width: '100%', margin: 0, cursor: 'pointer', zIndex: 2, opacity: 0.5 }} disabled={events.length === 0} 
            />
            </div>
          <span style={{ fontSize: '14px', width: '100px', textAlign: 'right', fontFamily: 'monospace' }}>{formatTime(currentTime)}</span>
        </div>
        <button onClick={() => { setIsPlaying(false); jumpToNext(); }} disabled={currentIndex >= events.length - 1} style={{ cursor: currentIndex >= events.length - 1 ? 'not-allowed' : 'pointer', padding: '0 15px' }}>▶</button>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden', border: '1px solid #ccc', borderRadius: '8px' }}>
        <div style={{ width: '100%', height: '100%', backgroundColor: '#f9f9f9' }}>
          <ReactFlow 
            nodes={rfNodes} edges={rfEdges} minZoom={0.05}
            onNodesChange={useCallback((changes) => setRfNodes((nds) => applyNodeChanges(changes, nds)), [])} 
            onEdgesChange={useCallback((changes) => setRfEdges((eds) => applyEdgeChanges(changes, eds)), [])}
            onNodeMouseEnter={onNodeMouseEnter} onNodeMouseLeave={() => setTooltip(null)}
            onEdgeMouseEnter={onEdgeMouseEnter} onEdgeMouseLeave={() => setTooltip(null)}
            onPaneClick={() => { setIsFocusReleased(true); if(isLiveRef.current){ setIsLive(false); isLiveRef.current = false; } }}
            onNodeClick={useCallback((_, node) => { setIsFocusReleased(false); if(isLiveRef.current){ setIsLive(false); isLiveRef.current = false; } for(let i = events.length - 1; i >= 0; i--){ if(getNormId(events[i].source) === node.id || getNormId(events[i].target) === node.id){ jumpToIndex(i); break; } } }, [events, getNormId, jumpToIndex])}
            onNodeDoubleClick={useCallback((_, node) => { setSearchQuery(node.id); setActiveTab('logs'); setIsFocusReleased(true); }, [])}
          >
            <Background color="#ccc" gap={16} />
            <Controls position="bottom-right" style={{ marginBottom: '20px', marginRight: '20px' }} />
          </ReactFlow>
        </div>

        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, display: 'flex', transform: isPanelOpen ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)', zIndex: 10, pointerEvents: 'none' }}>
          <div style={{ width: '45vw', minWidth: '400px', maxWidth: '600px', height: '100%', display: 'flex', gap: '10px', padding: '15px', boxSizing: 'border-box', backgroundColor: 'rgba(25, 25, 25, 0.90)', backdropFilter: 'blur(4px)', boxShadow: '4px 0 20px rgba(0,0,0,0.5)', pointerEvents: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px', border: '1px solid #444' }}>
              <span style={{ fontSize: '10px', color: '#999', fontWeight: 'bold', marginBottom: '10px' }}>Seq</span>
              <div style={{ position: 'relative', flex: 1, display: 'flex', justifyContent: 'center', width: '20px' }}>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '100%', transform: 'translateX(-50%)', pointerEvents: 'none' }}>
                  {(() => {
                    const maxPins = 200;
                    const step = Math.max(1, Math.floor(filteredEvents.length / maxPins));
                    return filteredEvents.filter((_, i) => i % step === 0).map((evt, i) => (
                      <div key={`seq-${evt.originalIndex}`} style={{ position: 'absolute', top: `${((i * step) / Math.max(1, filteredEvents.length - 1)) * 100}%`, left: '0', width: '100%', height: '2px', backgroundColor: getEventColor(evt.type), zIndex: 1, opacity: 0.8 }} />
                    ));
                  })()}
                </div>
                <input 
                  type="range" min="0" max={Math.max(0, filteredEvents.length - 1)} 
                  value={filteredEvents.findIndex(e => e.originalIndex === currentIndex) >= 0 ? filteredEvents.findIndex(e => e.originalIndex === currentIndex) : 0} 
                  onChange={(e) => { 
                    const fEvt = filteredEvents[Number(e.target.value)]; 
                    setIsPlaying(false);
                    if(fEvt) jumpToIndex(fEvt.originalIndex); 
                  }} 
                  style={{ writingMode: 'bt-lr', WebkitAppearance: 'slider-vertical', transform: 'rotate(180deg)', width: '12px', height: '100%', cursor: 'pointer', zIndex: 2, opacity: 0.5, margin: 0 }} 
                  disabled={filteredEvents.length === 0} 
                />
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
              <div style={{ backgroundColor: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px', border: '1px solid #444', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#999', marginRight: '4px' }}>Layers:</span>
                  {Object.keys(visibleEvents).map(type => (
                    <button key={type} onClick={() => { setVisibleEvents(p => ({...p, [type]: !p[type]})); setIsFocusReleased(true); }} style={{ padding: '4px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', backgroundColor: visibleEvents[type] ? getEventColor(type) : 'transparent', color: visibleEvents[type] ? '#fff' : '#666', border: `1px solid ${visibleEvents[type] ? getEventColor(type) : '#444'}` }}>{type}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type="text" placeholder="🔍 モジュール名、PID、Payloadで検索..." value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setIsFocusReleased(true); }} style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #555', backgroundColor: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px', flex: 1 }} />
                    <button onClick={resetFilters} style={{ padding: '6px 10px', borderRadius: '4px', backgroundColor: '#555', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '11px' }}>リセット</button>
                  </div>
                  <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', color: '#bbb' }}><input type="checkbox" checked={hideSystemMessages} onChange={(e) => { setHideSystemMessages(e.target.checked); setIsFocusReleased(true); }} /> OTPシステムメッセージを隠す</label>
                    <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', color: '#bbb' }}><input type="checkbox" checked={hideAnonymous} onChange={(e) => { setHideAnonymous(e.target.checked); setIsFocusReleased(true); }} /> 無名プロセスを隠す</label>
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid #444', borderRadius: '8px', backgroundColor: 'transparent' }}>
                <div style={{ display: 'flex', backgroundColor: '#333' }}>
                  <div onClick={() => setActiveTab('logs')} style={{ flex: 1, padding: '8px', textAlign: 'center', cursor: 'pointer', backgroundColor: activeTab === 'logs' ? '#4CAF50' : 'transparent', color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>Trace Logs</div>
                  <div onClick={() => setActiveTab('states')} style={{ flex: 1, padding: '8px', textAlign: 'center', cursor: 'pointer', backgroundColor: activeTab === 'states' ? '#C586C0' : 'transparent', color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>Current States</div>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', color: '#d4d4d4' }}>
                  {activeTab === 'logs' ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, backgroundColor: 'rgba(51, 51, 51, 0.95)', zIndex: 10 }}><tr><th style={{ padding: '6px' }}>PT (実時間)</th><th style={{ padding: '6px' }}>LT</th><th style={{ padding: '6px' }}>Type</th><th style={{ padding: '6px' }}>Source</th><th style={{ padding: '6px' }}>Target</th><th style={{ padding: '6px' }}>Payload</th></tr></thead>
                      <tbody>
                        {filteredEvents.map((evt, index) => {
                          const showPT = index === 0 || filteredEvents[index - 1].timestamp !== evt.timestamp;
                          const normSource = getNormId(evt.source);
                          const normTarget = getNormId(evt.target);
                          const finalSourceName = getFinalName(normSource, evt.source_name);
                          const finalTargetName = getFinalName(normTarget, evt.target_name);
                          const isSelected = evt.originalIndex === currentIndex;

                          return (
                            <tr key={evt.originalIndex} onClick={() => { setIsPlaying(false); jumpToIndex(evt.originalIndex); }} style={{ backgroundColor: evt.originalIndex === currentIndex ? 'rgba(76, 175, 80, 0.3)' : 'transparent', borderBottom: '1px solid #444', cursor: 'pointer' }}>
                              <td style={{ padding: '4px 6px', fontFamily: 'monospace', color: '#aaa', borderRight: '1px solid #555' }}>{showPT ? formatTime(evt.timestamp) : ''}</td>
                              <td style={{ padding: '4px 6px', fontFamily: 'monospace', color: '#aaa' }}>{evt.logicalCounter}</td>
                              <td style={{ padding: '4px 6px', color: getEventColor(evt.type), fontWeight: 'bold' }}>{evt.type}</td>
                              <td style={{ padding: '4px 6px' }}>{renderProcess(normSource, finalSourceName)}</td>
                              <td style={{ padding: '4px 6px' }}>{renderProcess(normTarget, finalTargetName)}</td>
                              <td style={{ 
                                padding: '4px 6px', 
                                color: getEventColor(evt.type), 
                                whiteSpace: isSelected ? 'pre-wrap' : 'nowrap', 
                                overflow: isSelected ? 'visible' : 'hidden', 
                                textOverflow: isSelected ? 'clip' : 'ellipsis', 
                                maxWidth: isSelected ? 'none' : '120px',
                                wordBreak: 'break-all'
                              }}>
                                {evt.payload || '-'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'left' }}>
                      <thead style={{ position: 'sticky', top: 0, backgroundColor: 'rgba(51, 51, 51, 0.95)', zIndex: 10 }}><tr><th style={{ padding: '6px', width: '30%' }}>Process</th><th style={{ padding: '6px' }}>Current State (Full)</th></tr></thead>
                      <tbody>
                        {rfNodes.filter(n => !n.hidden).filter(n => searchQuery === "" || (n.data.rawName || "").toLowerCase().includes(searchQuery.toLowerCase()) || n.id.toLowerCase().includes(searchQuery.toLowerCase())).map(node => (
                          <tr key={`state-${node.id}`} style={{ borderBottom: '1px solid #444' }}>
                            <td style={{ padding: '6px', color: '#fff', whiteSpace: 'nowrap', verticalAlign: 'top' }}><div style={{ fontWeight: 'bold' }}>{node.data.rawName || 'Anonymous'}</div><div style={{ fontSize: '9.5px', color: '#888', fontFamily: 'monospace' }}>{node.id}</div></td>
                            <td style={{ padding: '6px', color: '#DCDCAA', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{node.data.currentState || 'No state recorded'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div onClick={() => setIsPanelOpen(!isPanelOpen)} style={{ position: 'absolute', top: '15px', right: '-24px', width: '24px', height: '60px', backgroundColor: '#333', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', pointerEvents: 'auto', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', boxShadow: '4px 0 10px rgba(0,0,0,0.5)', fontSize: '12px' }}>{isPanelOpen ? '◀' : '▶'}</div>
        </div>

        {tooltip && (
          <div style={{ position: 'fixed', top: tooltip.y + 15, left: tooltip.x + 15, backgroundColor: 'rgba(0, 0, 0, 0.85)', color: '#fff', padding: '12px', borderRadius: '6px', fontSize: '13px', pointerEvents: 'none', zIndex: 9999, whiteSpace: 'pre-wrap', boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
            {tooltip.isNode ? (
              <>
                <div style={{ borderBottom: '1px solid #555', paddingBottom: '6px', marginBottom: '8px', display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ fontWeight: 'bold', color: tooltip.titleColor, fontSize: '14px' }}>{tooltip.title}</span>
                  <span style={{ fontSize: '11px', color: '#999', fontFamily: 'monospace' }}>{tooltip.pid}</span>
                </div>
                
                <div style={{ marginBottom: '8px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div>
                    Parent: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>
                      {tooltip.parentName && tooltip.parentName !== tooltip.parentId && tooltip.parentName !== "[]" && !tooltip.parentName.startsWith("#PID") 
                        ? `${tooltip.parentName} (${tooltip.parentId})` 
                        : tooltip.parentId}
                    </span>
                  </div>
                  <div>
                    <div style={{ marginBottom: '2px', color: '#999' }}>Activity:</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', backgroundColor: 'rgba(255,255,255,0.05)', padding: '6px', borderRadius: '4px', fontFamily: 'monospace' }}>
                      <div><span style={{ color: getEventColor('SEND') }}>SEND</span>: {tooltip.sendCount}</div>
                      <div><span style={{ color: getEventColor('RECEIVE') }}>RECEIVE</span>: {tooltip.receiveCount}</div>
                      <div><span style={{ color: getEventColor('SPAWN') }}>SPAWN</span>: {tooltip.spawnCount}</div>
                      <div><span style={{ color: getEventColor('LOCAL EVENT') }}>LOCAL EVENT</span>: {tooltip.localCount}</div>
                    </div>
                  </div>
                  <div>Last Event: <span style={{ color: getEventColor(tooltip.lastEvtType), fontWeight: 'bold', backgroundColor: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>{tooltip.lastEvtType}</span></div>
                </div>

                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #555', color: '#DCDCAA', fontFamily: 'monospace', fontSize: '11px' }}>
                  {tooltip.state}
                </div>
              </>
            ) : (
              <>
                <div style={{ borderBottom: '1px solid #555', paddingBottom: '6px', marginBottom: '8px', fontWeight: 'bold', fontSize: '14px' }}>
                  {tooltip.types.map((t, i) => (
                    <span key={t}>
                      <span style={{ color: getEventColor(t) }}>{t}</span>
                      {i < tooltip.types.length - 1 ? <span style={{ color: '#666', margin: '0 4px' }}>/</span> : ''}
                    </span>
                  ))}
                </div>
                
                <div style={{ marginBottom: '6px', fontSize: '11px', color: '#999', fontStyle: 'italic' }}>
                  ▼ Latest Communication
                </div>
                
                <div style={{ marginBottom: '4px', fontSize: '12px' }}>Type: <span style={{ color: getEventColor(tooltip.lType), fontWeight: 'bold' }}>{tooltip.lType}</span></div>
                <div style={{ marginBottom: '4px', fontSize: '12px' }}>From: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{tooltip.source}</span></div>
                <div style={{ marginBottom: '4px', fontSize: '12px' }}>To: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{tooltip.target}</span></div>
                <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed #555', color: '#DCDCAA', fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' }}>
                  {tooltip.payload}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  return (<ReactFlowProvider><TraceViewer /></ReactFlowProvider>)
}