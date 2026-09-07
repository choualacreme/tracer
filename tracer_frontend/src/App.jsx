import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Socket } from 'phoenix'
import { 
  ReactFlow, Background, Controls, 
  applyNodeChanges, applyEdgeChanges,
  ReactFlowProvider, useReactFlow 
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import dagre from 'dagre'

// ==========================================
// 定数・レイアウト計算・ヘルパー
// ==========================================
const nodeWidth = 150;
const nodeHeight = 40;

const getLayoutedElements = (nodes, edges, groupMembers, isPoolCollapsedFn) => {
  if (nodes.length === 0) return { nodes, edges };

  const MAX_COLS = 5;
  const COL_GAP = 85;
  const ROW_GAP = 65;
  const PAD_X = 40;
  const PAD_Y = 35;

  const pidToPool = new Map();
  if (groupMembers && isPoolCollapsedFn) {
    groupMembers.forEach((members, gId) => {
      if (!isPoolCollapsedFn(gId) && members.size >= 2) {
        members.forEach(pid => pidToPool.set(pid, gId));
      }
    });
  }

  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  // 上下の段差 (ranksep) を広げて親ノードとの接触を防ぐ
  dagreGraph.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 140, edgesep: 30 });

  const registeredPools = new Set();
  const poolDimensions = new Map();

  nodes.forEach((node) => {
    const gId = pidToPool.get(node.id);
    if (gId) {
      if (!registeredPools.has(gId)) {
        registeredPools.add(gId);
        const memberCount = groupMembers.get(gId).size;
        const cols = Math.min(memberCount, MAX_COLS);
        const rows = Math.ceil(memberCount / MAX_COLS);
        const width = (cols - 1) * COL_GAP + PAD_X * 2 + 30;
        const height = (rows - 1) * ROW_GAP + PAD_Y * 2 + 30;
        poolDimensions.set(gId, { width, height, cols, rows, memberCount });
        dagreGraph.setNode(`meta-${gId}`, { width, height });
      }
    } else {
      const w = parseInt(node.style?.width || nodeWidth, 10);
      const h = parseInt(node.style?.height || nodeHeight, 10);
      dagreGraph.setNode(node.id, { width: w, height: h });
    }
  });

  edges.forEach((edge) => {
    const s = pidToPool.has(edge.source) ? `meta-${pidToPool.get(edge.source)}` : edge.source;
    const t = pidToPool.has(edge.target) ? `meta-${pidToPool.get(edge.target)}` : edge.target;
    if (s !== t) {
      dagreGraph.setEdge(s, t);
    }
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = [];
  const poolMemberIndex = new Map();

  nodes.forEach((node) => {
    const gId = pidToPool.get(node.id);
    if (gId) {
      const poolMeta = dagreGraph.node(`meta-${gId}`);
      const dim = poolDimensions.get(gId);
      const idx = poolMemberIndex.get(gId) || 0;
      poolMemberIndex.set(gId, idx + 1);

      const row = Math.floor(idx / MAX_COLS);
      const col = idx % MAX_COLS;
      const remainingInRow = Math.min(dim.memberCount - row * MAX_COLS, MAX_COLS);
      const rowWidth = (remainingInRow - 1) * COL_GAP;

      // poolMeta の上端から確実に PAD_Y 分下げた位置から配置開始
      const startX = poolMeta.x - rowWidth / 2;
      const startY = (poolMeta.y - dim.height / 2) + PAD_Y + 10;

      layoutedNodes.push({
        ...node,
        targetPosition: 'top',
        sourcePosition: 'bottom',
        position: {
          x: startX + col * COL_GAP - 10,
          y: startY + row * ROW_GAP - 10,
        },
      });
    } else {
      const nodeWithPos = dagreGraph.node(node.id);
      const w = parseInt(node.style?.width || nodeWidth, 10);
      const h = parseInt(node.style?.height || nodeHeight, 10);
      layoutedNodes.push({
        ...node,
        targetPosition: 'top',
        sourcePosition: 'bottom',
        position: {
          x: nodeWithPos.x - w / 2,
          y: nodeWithPos.y - h / 2,
        },
      });
    }
  });

  return { nodes: layoutedNodes, edges };
};

const getEventColor = (type, payload = null) => {
  switch (type) {
    case 'SPAWN': return '#4CAF50';
    case 'SEND': return '#569CD6';
    case 'RECEIVE': return '#DCDCAA';
    case 'EXIT': 
      if (payload === ':normal' || payload === ':shutdown' || payload === 'normal' || payload === 'shutdown') return '#888888';
      return '#F44747';
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
  if (!payload || payload === 'nil' || payload === '-') return 'nil';
  const moduleMatch = payload.match(/([A-Z][a-zA-Z0-9_]*\.[A-Z][a-zA-Z0-9_]*)/);
  if (moduleMatch) return moduleMatch[1];
  const tupleMatch = payload.match(/^\{(:[a-zA-Z0-9_]+)/);
  if (tupleMatch) return tupleMatch[1];
  if (payload.startsWith(':')) return payload.split(/[\s,}]/)[0];
  const structMatch = payload.match(/^%([a-zA-Z0-9_.]+)/);
  if (structMatch) return `%${structMatch[1]}`;
  return payload.length > 15 ? payload.substring(0, 15) + '...' : payload;
};

// ==========================================
// メインコンポーネント
// ==========================================
function TraceViewer() {
  const { fitView, setCenter, getZoom } = useReactFlow();

  const [events, setEvents] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLive, setIsLive] = useState(true);
  const isLiveRef = useRef(true); 
  const [isPlaying, setIsPlaying] = useState(false); 
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [autoFocus, setAutoFocus] = useState(true);
  const isProgrammaticMove = useRef(false);

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
  const [showEdgeLabels, setShowEdgeLabels] = useState(false); 

  // 【機能追加】全体一括まとめフラグと個別の折り畳み状態（Set）
  const [isAutoGroupEnabled, setIsAutoGroupEnabled] = useState(false);
  const [collapsedPools, setCollapsedPools] = useState(new Set());

  const [rfNodes, setRfNodes] = useState([]);
  const [rfEdges, setRfEdges] = useState([]);

  // ==========================================
  // プロセス名・PIDの対応表
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

  // 当該プールが現在折り畳まれているかどうかの判定
  const isPoolCollapsed = useCallback((groupId) => {
    if (collapsedPools.has(groupId)) return true;
    if (isAutoGroupEnabled && !collapsedPools.has(`expanded-${groupId}`)) return true;
    return false;
  }, [collapsedPools, isAutoGroupEnabled]);

  const togglePoolCollapse = useCallback((groupId) => {
    setCollapsedPools(prev => {
      const next = new Set(prev);
      if (isAutoGroupEnabled) {
        if (next.has(`expanded-${groupId}`)) next.delete(`expanded-${groupId}`);
        else next.add(`expanded-${groupId}`);
      } else {
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
      }
      return next;
    });
  }, [isAutoGroupEnabled]);

  const getEffectiveId = useCallback((id) => {
    const gId = pidToGroupId.get(id);
    if (gId && (groupCounts.get(gId) || 0) >= 2 && isPoolCollapsed(gId)) {
      return gId;
    }
    return id;
  }, [pidToGroupId, groupCounts, isPoolCollapsed]);

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

      const processNode = (effId, rawId, name) => {
        if (!effId || allNodesMap.has(effId)) return;
        
        let displayLabel = effId;
        let nodeStyle = {};
        let rawName = name;
        
        if (effId.startsWith('pool-')) {
          const info = groupInfo.get(effId);
          const count = groupCounts.get(effId);
          displayLabel = `Pool: ${info?.sig || 'Workers'}\n(${count} processes)`;
          rawName = `Pool Node`;
          nodeStyle = { borderStyle: 'solid', borderWidth: '2px', borderColor: '#4CAF50', padding: '10px 20px', borderRadius: '50px', backgroundColor: 'white', color: '#333', minWidth: '160px', fontSize: '11px', textAlign: 'center', fontWeight: 'bold', transition: 'all 0.3s ease', cursor: 'pointer' };
        } else {
          const isPidString = rawId.startsWith("#PID");
          const hasRealName = name && name !== "[]" && !name.startsWith("#PID");
          displayLabel = hasRealName ? (isPidString ? `${name}\n(${rawId})` : name) : rawId;
          nodeStyle = { 
            borderStyle: 'solid', 
            borderWidth: '1px', 
            borderColor: '#888', 
            padding: '10px', 
            borderRadius: '5px', 
            backgroundColor: 'white', 
            color: '#333', 
            width: nodeWidth, 
            fontSize: '11px', 
            textAlign: 'center', 
            wordBreak: 'break-all', 
            transition: 'all 0.3s ease', 
            whiteSpace: 'pre-wrap' 
          };
        }

        allNodesMap.set(effId, { id: effId, data: { label: displayLabel, rawName: rawName, isPool: effId.startsWith('pool-') }, position: { x: 0, y: 0 }, style: nodeStyle });
        nLifecycles.set(effId, { spawnAt: idx, exitAt: Infinity, history: [] });
      };

      if (effSource) processNode(effSource, rawNormSource, getFinalName(rawNormSource, evt.source_name));
      if (effTarget) processNode(effTarget, rawNormTarget, getFinalName(rawNormTarget, evt.target_name));

      if (evt.type === 'EXIT' && nLifecycles.has(effSource)) {
        const lc = nLifecycles.get(effSource);
        if (effSource.startsWith('pool-')) {
          lc.exits = lc.exits || [];
          lc.exits.push(idx); 
        } else {
          lc.exitAt = idx;
        }
      }
      if (evt.type === 'LOCAL EVENT' && nLifecycles.has(effSource)) nLifecycles.get(effSource).history.push({ index: idx, state: evt.payload });
      
      if (['SPAWN', 'SEND', 'RECEIVE'].includes(evt.type) && effSource && effTarget) {
        const edgeId = `e-${effSource}-${effTarget}`;
        if (!allEdgesMap.has(edgeId)) {
          allEdgesMap.set(edgeId, { id: edgeId, source: effSource, target: effTarget, style: { stroke: getEventColor(evt.type, evt.payload), strokeWidth: 2 }, data: { types: new Set([evt.type]) } });
          eLifecycles.set(edgeId, { spawnAt: idx, history: [{ index: idx, payload: evt.payload, type: evt.type }] });
        } else {
          allEdgesMap.get(edgeId).data.types.add(evt.type); 
          eLifecycles.get(edgeId).history.push({ index: idx, payload: evt.payload, type: evt.type });
        }
      }
    });

    const layouted = getLayoutedElements(
      Array.from(allNodesMap.values()), 
      Array.from(allEdgesMap.values()),
      groupMembers,
      isPoolCollapsed
    );
    return { nodes: layouted.nodes, edges: layouted.edges, nLifecycles, eLifecycles };
  }, [events, getNormId, getFinalName, getEffectiveId, groupCounts, groupInfo, groupMembers, isPoolCollapsed]);

  useEffect(() => {
    if (masterData.nodes.length > 0 && rfNodes.length === 0) {
      isProgrammaticMove.current = true;
      setTimeout(() => {
        fitView({ padding: 0.2, duration: 500 });
        setTimeout(() => { isProgrammaticMove.current = false; }, 600);
      }, 50);
    }
  }, [masterData.nodes.length, fitView, rfNodes.length]);

  // ==========================================
  // フィルター判定
  // ==========================================
  const passesFilters = useCallback((evt) => {
    if (!evt || !visibleEvents[evt.type]) return false;
    
    if (hideSystemMessages) {
      const p = evt.payload || "";
      if (p === "timeout" || p === ":ack" || p.startsWith("{:ack") || p.startsWith("{:DOWN") || p.startsWith("{:EXIT")) return false;
      const sName = getFinalName(getNormId(evt.source), evt.source_name) || "";
      const tName = getFinalName(getNormId(evt.target), evt.target_name) || "";
      if (sName.includes("logger") || tName.includes("logger") || sName === ":timer_server" || tName === ":timer_server") return false;
    }

    if (hideAnonymous) {
      const sNorm = getNormId(evt.source);
      const tNorm = getNormId(evt.target);
      const sAnon = evt.source && (!(getFinalName(sNorm, evt.source_name)) || getFinalName(sNorm, evt.source_name) === "[]" || getFinalName(sNorm, evt.source_name).startsWith("#PID"));
      const tAnon = evt.target && (!(getFinalName(tNorm, evt.target_name)) || getFinalName(tNorm, evt.target_name) === "[]" || getFinalName(tNorm, evt.target_name).startsWith("#PID"));
      const sPooled = sNorm && getEffectiveId(sNorm).startsWith('pool-');
      const tPooled = tNorm && getEffectiveId(tNorm).startsWith('pool-');

      if (sAnon && !sPooled) return false;
      if (tAnon && !tPooled) return false;
    }
    
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
      if (!sName.includes(q) && !tName.includes(q) && !(getNormId(evt.source) || "").toLowerCase().includes(q) && !(getNormId(evt.target) || "").toLowerCase().includes(q) && !(evt.payload || "").toLowerCase().includes(q)) return false;
    }
    return true;
  }, [hideSystemMessages, hideAnonymous, searchQuery, visibleEvents, getNormId, getFinalName, getEffectiveId, pidToGroupId]);

  const filteredEvents = useMemo(() => events.map((evt, idx) => ({ ...evt, originalIndex: idx })).filter(passesFilters), [events, passesFilters]);

  // ==========================================
  // 描画データ生成とグループ囲み境界の計算
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
    
    // 【追加】現在時刻(currentIndex)時点で出現しているプールメンバーのPIDをプールごとに集計
    const currentActiveGroupMembers = new Map();
    groupMembers.forEach((memberPids, gId) => {
      const activePids = new Set();
      memberPids.forEach(pid => {
        const lc = masterData.nLifecycles.get(pid);
        if (lc && lc.spawnAt <= currentIndex) {
          activePids.add(pid);
        }
      });
      currentActiveGroupMembers.set(gId, activePids);
    });

    const updatedNodes = masterData.nodes.map(node => {
      const lc = masterData.nLifecycles.get(node.id);
      const isSpawned = lc && lc.spawnAt <= currentIndex;
      const isFocused = currentEvt && isEventVisible && (node.id === curNormSource || node.id === curNormTarget);
      const isAnonymousNode = !node.data.rawName || node.data.rawName === "[]" || node.data.rawName.startsWith("#PID");
      const matchesSearch = searchQuery === "" || (node.data.rawName && node.data.rawName.toLowerCase().includes(q)) || node.id.toLowerCase().includes(q);

      let currentState = "No state yet";
      if (lc && lc.history) {
        const pastStates = lc.history.filter(h => h.index <= currentIndex);
        if (pastStates.length > 0) currentState = pastStates[pastStates.length - 1].state;
      }

      let newStyle = { ...node.style, opacity: 1, boxShadow: 'none' };
      let isDead = false;
      let displayLabel = node.data.label;

      // 【修正】プール所属ノードの動的形状切り替え判定
      const gId = pidToGroupId.get(node.id);
      const activeMembersInPool = gId ? currentActiveGroupMembers.get(gId) : null;
      // 現在時刻時点で2件以上出現しており、かつ折り畳まれていない場合に小円化
      const isCurrentlyPooledWorker = activeMembersInPool && activeMembersInPool.size >= 2 && !isPoolCollapsed(gId);

      if (node.data.isPool) {
        const total = groupCounts.get(node.id) || 0;
        const members = groupMembers.get(node.id) ? Array.from(groupMembers.get(node.id)) : [];

        // 【修正】各メンバープロセスの spawnAt と exitAt を直接参照して生存数を正確に算出
        let spawnedCount = 0;
        let aliveCount = 0;

        members.forEach(pid => {
          const pLc = masterData.nLifecycles.get(pid);
          if (pLc && pLc.spawnAt <= currentIndex) {
            spawnedCount++;
            if (pLc.exitAt > currentIndex) {
              aliveCount++;
            }
          }
        });

        // 過去に1機以上スポーンしており、現在生存しているプロセスが0なら全滅判定
        const isAllDead = spawnedCount > 0 && aliveCount === 0;
        isDead = isAllDead;

        const sig = groupInfo.get(node.id)?.sig || 'Worker';

        // 【修正】死亡数行(💀 ...)を削除し、分数表示のみに統一
        displayLabel = `Pool: ${sig}\n(${aliveCount}/${total} alive)`;

        if (!isSpawned) {
          newStyle.opacity = 0;
        } else if (isAllDead) {
          newStyle.backgroundColor = '#333333';
          newStyle.color = '#aaaaaa';
          newStyle.opacity = 0.5;
          newStyle.borderStyle = 'dashed';
          newStyle.borderColor = '#777';
        } else {
          if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.3;
        }
      } else if (isCurrentlyPooledWorker) {
        // 現在時刻で複数存在するため、小円バッジスタイルを動的適用
        isDead = lc && lc.exitAt <= currentIndex;
        displayLabel = (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <span style={{ 
              position: 'absolute', 
              top: '18px', 
              left: '14px', 
              fontSize: '9px', 
              fontFamily: 'monospace', 
              color: '#64748b', 
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              userSelect: 'none'
            }}>
              {node.id}
            </span>
          </div>
        );
        newStyle = { 
          width: 20, 
          height: 20, 
          borderRadius: '50%', 
          backgroundColor: isDead ? '#333333' : '#e2e8f0', 
          borderStyle: isDead ? 'dashed' : 'solid', 
          borderWidth: '2px', 
          borderColor: isDead ? '#777' : '#64748b', 
          boxSizing: 'border-box',
          padding: 0,
          opacity: (!isSpawned) ? 0 : (isDead ? 0.5 : (currentEvt && !isFocused && !isFocusReleased ? 0.3 : 1)),
          transition: 'all 0.3s ease' 
        };
      } else {
        // 単独プロセス（遡行して1つしかいないワーカーを含む）
        isDead = lc && lc.exitAt <= currentIndex;
        if (!isSpawned) newStyle.opacity = 0; 
        else if (isDead) { newStyle.backgroundColor = '#333333'; newStyle.color = '#aaaaaa'; newStyle.opacity = 0.5; newStyle.borderStyle = 'dashed'; newStyle.borderColor = '#777'; }
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
      
      return { ...node, data: { ...node.data, label: displayLabel, currentState, isDead }, style: newStyle, hidden: !isSpawned || (hideAnonymous && isAnonymousNode) };    
    });

    // グループ境界ノードの生成も、現在時刻で2つ以上アクティブな場合のみにする
    const groupBoundingNodes = [];
    currentActiveGroupMembers.forEach((activePids, gId) => {
      if (!isPoolCollapsed(gId) && activePids.size >= 2) {
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
          const boxWidth = maxX - minX + padX * 2;
          const boxHeight = maxY - minY + padY * 2;
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
            style: { width: boxWidth, height: boxHeight, zIndex: -1 },
            className: 'pool-group-node',
            draggable: false,
            selectable: false
          });
        }
      }
    });

    // 【エッジ集約処理】プール所属ノードの外部接続先をグループ枠(box-*)または折り畳みプールへ集約
    const getEndpointId = (rawId) => {
      const gId = pidToGroupId.get(rawId);
      if (!gId || (groupCounts.get(gId) || 0) < 2) return rawId;
      if (isPoolCollapsed(gId)) return gId;
      // 展開時：現在時刻で2つ以上アクティブならグループ枠へ集約
      const activeMembers = currentActiveGroupMembers.get(gId);
      if (activeMembers && activeMembers.size >= 2) return `box-${gId}`;
      return rawId;
    };

    const aggregatedEdgesMap = new Map();

    masterData.edges.forEach(edge => {
      const aggSource = getEndpointId(edge.source);
      const aggTarget = getEndpointId(edge.target);

      // プール内部同士の通信はそのまま、外部との通信はグループ枠へ集約
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
          spawnAt: lc?.spawnAt ?? 0,
          originalEdges: [edge]
        });
      } else {
        const existing = aggregatedEdgesMap.get(aggEdgeId);
        edge.data.types.forEach(t => existing.types.add(t));
        if (lc?.history) existing.history.push(...lc.history);
        existing.spawnAt = Math.min(existing.spawnAt, lc?.spawnAt ?? 0);
        existing.originalEdges.push(edge);
      }
    });

    const updatedEdges = Array.from(aggregatedEdgesMap.values()).map(aggEdge => {
      const isSpawned = aggEdge.spawnAt <= currentIndex;

      // 履歴をインデックス順にソートして直近イベントを決定
      const pastEvents = aggEdge.history
        .filter(h => h.index <= currentIndex)
        .sort((a, b) => a.index - b.index);

      let currentPayload = "No data yet", latestType = "UNKNOWN";
      if (pastEvents.length > 0) {
        const last = pastEvents[pastEvents.length - 1];
        currentPayload = last.payload;
        latestType = last.type;
      }

      // 現在のイベントがこの集約エッジに含まれるか
      const isFocused = currentEvt && isEventVisible && (
        (curNormSource === aggEdge.source || getEndpointId(curNormSource) === aggEdge.source) &&
        (curNormTarget === aggEdge.target || getEndpointId(curNormTarget) === aggEdge.target)
      );

      let edgeBaseColor = '#aaaaaa';
      if (aggEdge.types.has('SEND') && visibleEvents['SEND']) edgeBaseColor = getEventColor('SEND', currentPayload);
      else if (aggEdge.types.has('RECEIVE') && visibleEvents['RECEIVE']) edgeBaseColor = getEventColor('RECEIVE', currentPayload);
      else if (aggEdge.types.has('SPAWN') && visibleEvents['SPAWN']) edgeBaseColor = getEventColor('SPAWN', currentPayload);

      let newStyle = { stroke: edgeBaseColor, opacity: 1, strokeWidth: 2 };
      let animated = false, zIndex = 0;

      if (!isSpawned) newStyle.opacity = 0;
      else if (currentEvt && !isFocused && !isFocusReleased) newStyle.opacity = 0.2;

      if (isSpawned && isFocused) {
        newStyle.stroke = getEventColor(currentEvt.type, currentEvt.payload);
        newStyle.strokeWidth = 4;
        animated = true;
        zIndex = 1000;
      }

      const isSysMsg = currentPayload === "timeout" || currentPayload.startsWith("{:DOWN") || currentPayload.startsWith("{:EXIT");
      const hasVisibleType = Array.from(aggEdge.types).some(t => visibleEvents[t]);
      const hiddenByFilter = (hideSystemMessages && isSysMsg) || !hasVisibleType;

      const signature = extractSignature(currentPayload);
      const labelStyle = { fill: edgeBaseColor, fontWeight: 'bold', fontSize: 10, opacity: newStyle.opacity };
      const labelBgStyle = { fill: 'rgba(255, 255, 255, 0.8)', stroke: edgeBaseColor, strokeWidth: 1, rx: 4, ry: 4, opacity: newStyle.opacity };

      return { 
        id: aggEdge.id,
        source: aggEdge.source,
        target: aggEdge.target,
        data: { types: aggEdge.types, currentPayload, latestType, signature }, 
        style: newStyle,
        animated,
        zIndex,
        hidden: !isSpawned || hiddenByFilter,
        label: (isSpawned && !hiddenByFilter && currentPayload !== "No data yet" && showEdgeLabels) ? signature : undefined,
        labelStyle,
        labelBgStyle,
        labelShowBg: true
      };   
    });

    // グループ境界ノードを背面に挿入して描画
    setRfNodes([...groupBoundingNodes, ...updatedNodes]);
    setRfEdges(updatedEdges);
  }, [currentIndex, masterData, events, isFocusReleased, getNormId, searchQuery, hideSystemMessages, hideAnonymous, visibleEvents, groupCounts, groupInfo, showEdgeLabels, getEffectiveId, groupMembers, isPoolCollapsed, togglePoolCollapse]);

  // ==========================================
  // 自動スクロールとナビゲーション
  // ==========================================
  useEffect(() => {
    if (currentIndex >= 0 && activeTab === 'logs') {
      const row = document.getElementById(`log-row-${currentIndex}`);
      const container = document.getElementById('log-table-container');
      if (row && container) {
        const rowTop = row.offsetTop;
        const containerHeight = container.clientHeight;
        container.scrollTo({
          top: rowTop - (containerHeight / 2) + (row.clientHeight / 2),
          behavior: 'smooth'
        });
      }
    }
  }, [currentIndex, activeTab]);

  useEffect(() => {
    const wsHost = window.location.hostname === 'localhost' ? 'ws://localhost:4000/socket' : `wss://${window.location.host}/socket`;
    const socket = new Socket(wsHost, { params: {} });
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
    if (!isLiveRef.current || !autoFocus || !evt || masterData.nodes.length === 0) return;
    let targetX = 0, targetY = 0, validNodesCount = 0;
    const addNodeCoord = (id) => {
      const node = masterData.nodes.find(n => n.id === id);
      if (node) { targetX += node.position.x + 75; targetY += node.position.y + 20; validNodesCount++; }
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
    if (isLiveRef.current && autoFocus && events[currentIndex]) focusOnEvent(events[currentIndex]); 
  }, [currentIndex, events, focusOnEvent, autoFocus]);

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
    setSearchQuery(""); setHideSystemMessages(false); setHideAnonymous(false);
    setVisibleEvents({ 'SPAWN': true, 'SEND': true, 'RECEIVE': true, 'EXIT': true, 'LOCAL EVENT': true });
    setIsFocusReleased(true);
  }, []);

  const onNodeMouseEnter = useCallback((e, node) => {
    if (node.data?.isGroupBoundingBox) return;
    let lastEvtType = 'NONE', parentId = '-', parentName = null, sendCount = 0, receiveCount = 0, spawnCount = 0, localCount = 0;
    for (let i = 0; i <= currentIndex; i++) {
      const ev = events[i];
      if (!ev) continue;
      const isSource = getEffectiveId(getNormId(ev.source)) === node.id;
      const isTarget = getEffectiveId(getNormId(ev.target)) === node.id;
      if (ev.type === 'SPAWN') {
        if (isTarget) { parentId = getNormId(ev.source); parentName = getFinalName(parentId, ev.source_name); }
        if (isSource) spawnCount++;
      }
      if (ev.type === 'SEND' && isSource) sendCount++;
      if (ev.type === 'RECEIVE' && isTarget) receiveCount++;
      if (ev.type === 'LOCAL EVENT' && isSource) localCount++;
      if (isSource || isTarget) lastEvtType = ev.type;
    }
    const displayState = (node.data.currentState || 'N/A').length > 200 ? (node.data.currentState || 'N/A').substring(0, 200) + ' ... ' : (node.data.currentState || 'N/A');
    setTooltip({ x: e.clientX, y: e.clientY, isNode: true, title: node.data.rawName || 'Anonymous', titleColor: getEventColor(lastEvtType), pid: node.id, parentId, parentName, sendCount, receiveCount, spawnCount, localCount, lastEvtType, state: displayState });
  }, [currentIndex, events, getNormId, getFinalName, getEffectiveId]);

  const onEdgeMouseEnter = useCallback((e, edge) => {
    const typesArr = edge.data?.types ? Array.from(edge.data.types) : ['UNKNOWN'];
    const displayPayload = (edge.data?.currentPayload || 'nil').length > 100 ? (edge.data?.currentPayload || 'nil').substring(0, 100) + ' ...' : (edge.data?.currentPayload || 'nil');
    setTooltip({ x: e.clientX, y: e.clientY, isNode: false, types: typesArr, lType: edge.data?.latestType || 'UNKNOWN', source: edge.source, target: edge.target, payload: displayPayload });
  }, []);

  useEffect(() => {
    if (isPlaying && !isLive && currentIndex < events.length - 1) {
      const currentEvt = events[currentIndex];
      const nextEvt = events[currentIndex + 1];
      let delay = nextEvt.timestamp - currentEvt.timestamp;
      delay = Math.min(Math.max(delay, 50), 2000) / playbackSpeed;

      const timer = setTimeout(() => {
        jumpToNext();
      }, delay);
      return () => clearTimeout(timer);
    } else if (isPlaying && currentIndex >= events.length - 1) {
      setIsPlaying(false);
    }
  }, [isPlaying, isLive, currentIndex, events, jumpToNext, playbackSpeed]);

  const renderProcess = useCallback((id, name) => {
    if (!id) return '-';
    if (name && name !== "[]" && !name.startsWith("#PID")) return (
      <div style={{ lineHeight: '1.2' }}>
        <div style={{ fontWeight: 'bold' }}>{name}</div>
        {id.startsWith("#PID") && <div style={{ fontSize: '9.5px', color: '#888', fontFamily: 'monospace' }}>{id}</div>}
      </div>
    );
    return <span style={{ fontFamily: 'monospace', color: '#444', fontWeight: 'bold' }}>{id}</span>;
  }, []);

  const timeRange = (events.length > 0 ? events[events.length - 1].timestamp : 0) - (events.length > 0 ? events[0].timestamp : 0) || 1;

  return (
    <div className="app-container">
      <h2 className="app-title">Actor Model Trace Viewer</h2>

      {/* ヘッダー操作パネル */}
      <div className="header-controls">        
        <button onClick={() => { setEvents([]); setCurrentIndex(-1); setCurrentTime(0); setIsLive(true); isLiveRef.current = true; setIsPlaying(false); setCollapsedPools(new Set()); }} className="btn-clear">
          ログ・グラフをクリア
        </button>
        
        <button 
          onClick={() => { 
            const next = !isLive; 
            setIsLive(next); 
            isLiveRef.current = next; 
            setIsPlaying(false); 
            if(next && events.length > 0){ 
              setCurrentIndex(events.length - 1); 
              setCurrentTime(events[events.length - 1].timestamp); 
            } 
          }} 
          className={`btn-base ${isLive ? 'btn-live-active' : 'btn-live-paused'}`}
        >
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

      {/* タイムライン・シークバー */}
      <div className="timeline-card">
        <button onClick={() => { setIsPlaying(false); jumpToPrev(); }} disabled={currentIndex <= 0} className="timeline-step-btn">◀</button>
        <div className="timeline-track-wrap">
          <span className="timeline-label">Real-time</span>
          <div className="timeline-bar-container">
            <div className="timeline-pins-overlay">
              {(() => {
                const maxPins = 200;
                const step = Math.max(1, Math.floor(filteredEvents.length / maxPins));
                return filteredEvents.filter((_, i) => i % step === 0).map((evt) => (
                  <div key={`time-hl-${evt.originalIndex}`} className="timeline-pin" style={{ left: `${((evt.timestamp - (events[0]?.timestamp || 0)) / timeRange) * 100}%` }} />
                ));
              })()}
            </div>
            <input 
              type="range" min={events[0]?.timestamp || 0} max={events[events.length - 1]?.timestamp || 0} value={currentTime} 
              onChange={(e) => { 
                const t = Number(e.target.value); 
                setCurrentTime(t); setIsFocusReleased(false); setIsPlaying(false);
                if(isLive){ setIsLive(false); isLiveRef.current = false; } 
                let n = -1; 
                for(let i = events.length - 1; i >= 0; i--){ if(events[i].timestamp <= t){ n = i; break; } } 
                setCurrentIndex(n); 
              }} 
              className="timeline-range-input" disabled={events.length === 0} 
            />
          </div>
          <span className="timeline-clock">{formatTime(currentTime)}</span>
        </div>
        <button onClick={() => { setIsPlaying(false); jumpToNext(); }} disabled={currentIndex >= events.length - 1} className="timeline-step-btn">▶</button>
      </div>

      {/* グラフ領域とオーバーレイパネル */}
      <div className="canvas-wrapper">
        <div className="graph-full-container">
          <ReactFlow 
            nodes={rfNodes} edges={rfEdges} minZoom={0.05}
            onNodesChange={useCallback((changes) => setRfNodes((nds) => applyNodeChanges(changes, nds)), [])} 
            onEdgesChange={useCallback((changes) => setRfEdges((eds) => applyEdgeChanges(changes, eds)), [])}
            onNodeMouseEnter={onNodeMouseEnter} onNodeMouseLeave={() => setTooltip(null)}
            onEdgeMouseEnter={onEdgeMouseEnter} onEdgeMouseLeave={() => setTooltip(null)}
            onPaneClick={() => {
              setIsFocusReleased(true);
              if (isLiveRef.current) setAutoFocus(false);
            }}
            onMove={useCallback((event) => {
              if (isLiveRef.current && event && (event instanceof MouseEvent || event instanceof WheelEvent || (window.TouchEvent && event instanceof TouchEvent))) {
                setAutoFocus(false);
              }
            }, [])}
            onNodeClick={useCallback((_, node) => { 
              // グループ囲み枠のクリック時
              if (node.data?.isGroupBoundingBox) {
                togglePoolCollapse(node.data.groupId);
                return;
              }
              // 折り畳まれたプールノードのクリック時（展開する）
              if (node.data?.isPool) {
                togglePoolCollapse(node.id);
                return;
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

        {/* オーバーレイ型 左側パネル */}
        <div className={`overlay-panel-container ${isPanelOpen ? 'panel-open' : 'panel-closed'}`}>
          <div className="panel-body">
            
            {/* 縦型シークバー (Seq) */}
            <div className="seq-rail">
              <span className="seq-label">Seq</span>
              <div className="seq-track-box">
                <div className="seq-pins-overlay">
                  {(() => {
                    const maxPins = 200;
                    const step = Math.max(1, Math.floor(filteredEvents.length / maxPins));
                    return filteredEvents.filter((_, i) => i % step === 0).map((evt, i) => (
                      <div key={`seq-${evt.originalIndex}`} className="seq-pin" style={{ top: `${((i * step) / Math.max(1, filteredEvents.length - 1)) * 100}%`, backgroundColor: getEventColor(evt.type, evt.payload) }} />
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
                  className="seq-range-input"
                  disabled={filteredEvents.length === 0} 
                />
              </div>
            </div>

            {/* パネルメインコンテンツ */}
            <div className="panel-main-content">
              <div className="filter-box">
                <div className="layers-row">
                  <span className="layers-label">Layers:</span>
                  {Object.keys(visibleEvents).map(type => (
                    <button 
                      key={type} 
                      onClick={() => { setVisibleEvents(p => ({...p, [type]: !p[type]})); setIsFocusReleased(true); }} 
                      className="layer-tag-btn"
                      style={{ 
                        backgroundColor: visibleEvents[type] ? getEventColor(type) : 'transparent', 
                        color: visibleEvents[type] ? '#fff' : '#666', 
                        border: `1px solid ${visibleEvents[type] ? getEventColor(type) : '#444'}` 
                      }}
                    >
                      {type}
                    </button>
                  ))}
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div className="search-row">
                    <input type="text" placeholder="🔍 モジュール名、PID、Payloadで検索..." value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setIsFocusReleased(true); }} className="search-input" />
                    <button onClick={resetFilters} className="search-reset-btn">リセット</button>
                  </div>
                  <div className="options-row">
                    <label className="checkbox-label"><input type="checkbox" checked={hideSystemMessages} onChange={(e) => { setHideSystemMessages(e.target.checked); setIsFocusReleased(true); }} /> OTPシステムメッセージを隠す</label>
                    <label className="checkbox-label"><input type="checkbox" checked={hideAnonymous} onChange={(e) => { setHideAnonymous(e.target.checked); setIsFocusReleased(true); }} /> 単独の無名プロセスを隠す</label>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={isAutoGroupEnabled} onChange={(e) => { 
                        setIsAutoGroupEnabled(e.target.checked); 
                        setCollapsedPools(new Set()); // モード切替時に個別ステートを初期化
                        setIsFocusReleased(true); 
                        if (searchQuery.startsWith('pool-')) setSearchQuery(""); 
                      }} /> 同種プロセスをまとめる
                    </label>
                  </div>
                </div>
              </div>

              {/* ログ・ステート表示テーブル */}
              <div className="table-tabs-container">
                <div className="tabs-header">
                  <div onClick={() => setActiveTab('logs')} className={`tab-btn ${activeTab === 'logs' ? 'tab-active-logs' : 'tab-inactive'}`}>Trace Logs</div>
                  <div onClick={() => setActiveTab('states')} className={`tab-btn ${activeTab === 'states' ? 'tab-active-states' : 'tab-inactive'}`}>Current States</div>
                </div>
                
                <div id="log-table-container" className="table-scroll-area">
                  {activeTab === 'logs' ? (
                    <table className="data-table">
                      <thead className="data-table-head">
                        <tr>
                          <th className="th-pt">PT (実時間)</th>
                          <th className="th-lt">LT</th>
                          <th className="th-type">Type</th>
                          <th className="th-source">Source</th>
                          <th className="th-target">Target</th>
                          <th className="th-payload">Payload</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEvents.map((evt, index) => {
                          const showPT = index === 0 || filteredEvents[index - 1].timestamp !== evt.timestamp;
                          const normSource = getNormId(evt.source);
                          const normTarget = getNormId(evt.target);
                          const finalSourceName = getFinalName(normSource, evt.source_name);
                          const finalTargetName = getFinalName(normTarget, evt.target_name);
                          const isSelected = evt.originalIndex === currentIndex;

                          return (
                            <tr id={`log-row-${evt.originalIndex}`} key={evt.originalIndex} onClick={() => { setIsPlaying(false); jumpToIndex(evt.originalIndex); }} className={`log-row ${isSelected ? 'log-row-selected' : ''}`}>
                              <td className="col-pt">{showPT ? formatTime(evt.timestamp) : ''}</td>
                              <td className="col-lt">{evt.logicalCounter}</td>
                              <td className="col-type" style={{ color: getEventColor(evt.type, evt.payload) }}>{evt.type}</td>
                              <td className="col-process">{renderProcess(normSource, finalSourceName)}</td>
                              <td className="col-process">{renderProcess(normTarget, finalTargetName)}</td>
                              <td 
                                className={`col-payload ${isSelected ? 'col-payload-expand' : 'col-payload-clamp'}`}
                                style={{ color: getEventColor(evt.type, evt.payload) }}
                              >
                                {evt.payload || '-'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table className="data-table">
                      <thead className="data-table-head"><tr><th style={{ width: '30%' }}>Process</th><th>Current State (Full)</th></tr></thead>
                      <tbody>
                        {rfNodes.filter(n => !n.hidden && !n.data?.isGroupBoundingBox).filter(n => searchQuery === "" || (n.data.rawName || "").toLowerCase().includes(searchQuery.toLowerCase()) || n.id.toLowerCase().includes(searchQuery.toLowerCase())).map(node => (
                          <tr key={`state-${node.id}`} className="log-row">
                            <td className="col-process" style={{ color: '#fff', verticalAlign: 'top' }}>
                              <div style={{ fontWeight: 'bold' }}>{node.data.rawName || 'Anonymous'}</div>
                              <div style={{ fontSize: '9.5px', color: '#888', fontFamily: 'monospace' }}>{node.id}</div>
                            </td>
                            <td className="col-payload" style={{ color: '#DCDCAA', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{node.data.currentState || 'No state recorded'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div onClick={() => setIsPanelOpen(!isPanelOpen)} className="panel-toggle-tab">
            {isPanelOpen ? '◀' : '▶'}
          </div>
        </div>
      </div>

      {/* ツールチップ */}
      {tooltip && (
        <div className="floating-tooltip" style={{ top: tooltip.y + 15, left: tooltip.x + 15 }}>
          {tooltip.isNode ? (
            <>
              <div className="tooltip-header">
                <span className="tooltip-title" style={{ color: tooltip.titleColor }}>{tooltip.title}</span>
                <span className="tooltip-pid">{tooltip.pid}</span>
              </div>
              <div style={{ marginBottom: '8px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div>Parent: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{tooltip.parentName && tooltip.parentName !== tooltip.parentId && tooltip.parentName !== "[]" && !tooltip.parentName.startsWith("#PID") ? `${tooltip.parentName} (${tooltip.parentId})` : tooltip.parentId}</span></div>
                <div>
                  <div style={{ marginBottom: '2px', color: '#999' }}>Activity:</div>
                  <div className="tooltip-grid-activities">
                    <div><span style={{ color: getEventColor('SEND') }}>SEND</span>: {tooltip.sendCount}</div>
                    <div><span style={{ color: getEventColor('RECEIVE') }}>RECEIVE</span>: {tooltip.receiveCount}</div>
                    <div><span style={{ color: getEventColor('SPAWN') }}>SPAWN</span>: {tooltip.spawnCount}</div>
                    <div><span style={{ color: getEventColor('LOCAL EVENT') }}>LOCAL EVENT</span>: {tooltip.localCount}</div>
                  </div>
                </div>
                <div>Last Event: <span style={{ color: getEventColor(tooltip.lastEvtType), fontWeight: 'bold', backgroundColor: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>{tooltip.lastEvtType}</span></div>
              </div>
              <div className="tooltip-state-box">{tooltip.state}</div>
            </>
          ) : (
            <>
              <div className="tooltip-header" style={{ fontWeight: 'bold', fontSize: '14px' }}>
                {tooltip.types.map((t, i) => (<span key={t}><span style={{ color: getEventColor(t) }}>{t}</span>{i < tooltip.types.length - 1 ? <span style={{ color: '#666', margin: '0 4px' }}>/</span> : ''}</span>))}
              </div>
              <div style={{ marginBottom: '6px', fontSize: '11px', color: '#999', fontStyle: 'italic' }}>▼ Latest Communication</div>
              <div style={{ marginBottom: '4px', fontSize: '12px' }}>Type: <span style={{ color: getEventColor(tooltip.lType), fontWeight: 'bold' }}>{tooltip.lType}</span></div>
              <div style={{ marginBottom: '4px', fontSize: '12px' }}>From: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{tooltip.source}</span></div>
              <div style={{ marginBottom: '4px', fontSize: '12px' }}>To: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{tooltip.target}</span></div>
              <div className="tooltip-state-box">{tooltip.payload}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  return (<ReactFlowProvider><TraceViewer /></ReactFlowProvider>)
}