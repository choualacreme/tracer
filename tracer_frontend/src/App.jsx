import { useEffect, useState, useCallback, useRef } from 'react'
import { Socket } from 'phoenix'
import { 
  ReactFlow, 
  Background, 
  Controls, 
  applyNodeChanges, 
  applyEdgeChanges,
  ReactFlowProvider,
  useReactFlow 
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'

// --- dagreのセットアップとレイアウト計算関数 ---
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const nodeWidth = 150;
const nodeHeight = 40;

const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: 'top',
      sourcePosition: 'bottom',
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: newNodes, edges };
};
// ----------------------------------------------

// --- タイムトラベル用の状態計算ロジック ---
const calculateGraphState = (allEvents, targetIndex) => {
  const nodesMap = new Map();
  const edgesMap = new Map();

  // ノード追加のヘルパー関数
  const addNode = (id) => {
    if (!id || nodesMap.has(id)) return;
    nodesMap.set(id, {
      id: id,
      data: { label: id },
      position: { x: 0, y: 0 },
      style: { 
        border: '1px solid #4CAF50', 
        padding: '10px', 
        borderRadius: '5px', 
        backgroundColor: 'white',
        width: nodeWidth, // 事前に定義した nodeWidth (150)
        fontSize: '12px',
        textAlign: 'center',
        wordBreak: 'break-all',
        transition: 'all 0.3s ease'
      }
    });
  };

  // 0番目から targetIndex までのイベントを順番にリプレイ（Reduce）する
  for (let i = 0; i <= targetIndex; i++) {
    const evt = allEvents[i];
    if (!evt) continue;

    // 1. ノードの生成（EXIT以外）
    if (evt.type !== 'EXIT') {
      addNode(evt.source);
      addNode(evt.target);
    }

    // 2. エッジの生成
    if (evt.source && evt.target && evt.type !== 'EXIT') {
      const edgeId = `e-${evt.source}-${evt.target}`;
      if (!edgesMap.has(edgeId)) {
        edgesMap.set(edgeId, {
          id: edgeId,
          source: evt.source,
          target: evt.target,
          animated: true,
          style: { stroke: '#569CD6', strokeWidth: 2 }
        });
      }
    }

    // 3. プロセス終了状態の上書き（ゴースト化）
    if (evt.type === 'EXIT') {
      if (nodesMap.has(evt.source)) {
        const node = nodesMap.get(evt.source);
        nodesMap.set(evt.source, {
          ...node,
          style: {
            ...node.style,
            backgroundColor: '#333333',
            border: '1px dashed #777',
            color: '#aaaaaa',
            opacity: 0.5 // ゴースト表示
          }
        });
      }
    }
  }

  return {
    rawNodes: Array.from(nodesMap.values()),
    rawEdges: Array.from(edgesMap.values())
  };
};

// --- イベントタイプごとの色を定義するヘルパー ---
const getEventColor = (type) => {
  switch (type) {
    case 'SPAWN': return '#4CAF50'; // 緑
    case 'SEND': return '#569CD6';  // 青
    case 'RECEIVE': return '#DCDCAA'; // 黄
    case 'EXIT': return '#F44747';  // 赤
    default: return '#aaaaaa';
  }
};

// --- タイムスタンプを HH:mm:ss.SSS 形式に変換するヘルパー ---
const formatTime = (ts) => {
  if (!ts) return "00:00:00.000";
  const d = new Date(ts);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

// メインのビューアコンポーネント
function TraceViewer() {
  const [events, setEvents] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  
  const [isLive, setIsLive] = useState(true);
  const isLiveRef = useRef(true); 

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  
  const { fitView } = useReactFlow();

  const onNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );
  const onEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const startTime = events.length > 0 ? events[0].timestamp : 0;
  const endTime = events.length > 0 ? events[events.length - 1].timestamp : 0;
  const timeRange = endTime - startTime || 1; 

  useEffect(() => {
    if (currentIndex < 0 || events.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const { rawNodes, rawEdges } = calculateGraphState(events, currentIndex);
    const layouted = getLayoutedElements(rawNodes, rawEdges);
    
    setNodes(layouted.nodes);
    setEdges(layouted.edges);

    setTimeout(() => {
      fitView({ padding: 0.2, duration: 500 });
    }, 50);
  }, [events, currentIndex, fitView]);

  useEffect(() => {
    const socket = new Socket("ws://localhost:4000/socket", { params: {} });
    socket.connect();
    const ch = socket.channel("trace_events:lobby", {});

    ch.join()
      .receive("ok", resp => { console.log("WebSocket接続成功！", resp) })
      .receive("error", resp => { console.error("WebSocket接続失敗", resp) });

    ch.on("new_trace_event", payload => {
      setEvents(prev => {
        const evt = { ...payload, timestamp: payload.timestamp || Date.now() };
        const newEvents = [...prev, evt];
        
        if (isLiveRef.current) {
          setCurrentIndex(newEvents.length - 1);
          setCurrentTime(evt.timestamp);
        }
        return newEvents;
      });
    });

    return () => {
      ch.leave();
      socket.disconnect();
    };
  }, []);

  const clearEvents = () => {
    setEvents([]);
    setCurrentIndex(-1);
    setCurrentTime(0);
    setIsLive(true);
    isLiveRef.current = true;
  };

  const toggleLive = () => {
    const nextLive = !isLive;
    setIsLive(nextLive);
    isLiveRef.current = nextLive;
    if (nextLive && events.length > 0) {
      const lastIdx = events.length - 1;
      setCurrentIndex(lastIdx);
      setCurrentTime(events[lastIdx].timestamp);
    }
  };

  // 【追加】インデックス（順序）バーを操作した時
  const handleIndexSeek = (e) => {
    const idx = Number(e.target.value);
    setCurrentIndex(idx);
    if (events[idx]) {
      setCurrentTime(events[idx].timestamp);
    }
    if (isLive) { setIsLive(false); isLiveRef.current = false; }
  };

  // 【追加】リアルタイム（実時間）バーを操作した時
  const handleTimeSeek = (e) => {
    const t = Number(e.target.value);
    setCurrentTime(t);
    if (isLive) { setIsLive(false); isLiveRef.current = false; }

    let nextIndex = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].timestamp <= t) {
        nextIndex = i;
        break;
      }
    }
    setCurrentIndex(nextIndex);
  };

  const jumpToPrev = () => {
    if (currentIndex > 0) {
      const prevIdx = currentIndex - 1;
      setCurrentIndex(prevIdx);
      setCurrentTime(events[prevIdx].timestamp);
      if (isLive) { setIsLive(false); isLiveRef.current = false; }
    }
  };

  const jumpToNext = () => {
    if (currentIndex < events.length - 1) {
      const nextIdx = currentIndex + 1;
      setCurrentIndex(nextIdx);
      setCurrentTime(events[nextIdx].timestamp);
      if (isLive) { setIsLive(false); isLiveRef.current = false; }
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', height: '100vh', boxSizing: 'border-box' }}>
      <h2>Actor Model Trace Viewer</h2>
      
      <div style={{ marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center' }}>        
        <button onClick={clearEvents} style={{ padding: '6px 12px', cursor: 'pointer' }}>
          ログ・グラフをクリア
        </button>

        <button 
          onClick={toggleLive} 
          style={{ 
            padding: '6px 12px', 
            cursor: 'pointer',
            backgroundColor: isLive ? '#4CAF50' : '#f44336',
            color: 'white',
            border: 'none',
            borderRadius: '4px'
          }}>
          {isLive ? '🔴 LIVE (自動追従中)' : '⏸ REPLAY (一時停止中)'}
        </button>
      </div>

      {/* 2段構成のタイムラインコントロール */}
      <div style={{ 
        marginBottom: '16px', padding: '15px', backgroundColor: '#fff', 
        border: '1px solid #ccc', borderRadius: '8px', display: 'flex', alignItems: 'stretch', gap: '15px' 
      }}>
        
        {/* 前へボタン */}
        <button 
          onClick={jumpToPrev} 
          disabled={currentIndex <= 0}
          style={{ cursor: currentIndex <= 0 ? 'not-allowed' : 'pointer', padding: '0 15px' }}
        >
          ◀
        </button>

        {/* シークバー群 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center' }}>
          
          {/* 上段：インデックス（順序）ベース */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', width: '65px', color: '#666', fontWeight: 'bold' }}>Sequence</span>
            <div style={{ position: 'relative', flex: 1, height: '16px', display: 'flex', alignItems: 'center' }}>
              {events.map((evt, i) => {
                const leftPercent = events.length > 1 ? (i / (events.length - 1)) * 100 : 0;
                return (
                  <div 
                    key={`seq-${i}`}
                    style={{
                      position: 'absolute',
                      left: `${leftPercent}%`,
                      width: '4px', height: '10px',
                      backgroundColor: getEventColor(evt.type),
                      transform: 'translateX(-50%)',
                      pointerEvents: 'none', zIndex: 1, opacity: 0.8
                    }}
                    title={`${evt.type} (${evt.source})`}
                  />
                );
              })}
              <input 
                type="range" min="0" max={Math.max(0, events.length - 1)} 
                value={currentIndex >= 0 ? currentIndex : 0} 
                onChange={handleIndexSeek}
                style={{ width: '100%', margin: 0, cursor: 'pointer', zIndex: 2, opacity: 0.5 }}
                disabled={events.length === 0}
              />
            </div>
            <span style={{ fontSize: '14px', width: '100px', textAlign: 'right', fontFamily: 'monospace' }}>
              {events.length === 0 ? 0 : currentIndex + 1} / {events.length}
            </span>
          </div>

          {/* 下段：リアルタイム（実時間）ベース */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', width: '65px', color: '#666', fontWeight: 'bold' }}>Real-time</span>
            <div style={{ position: 'relative', flex: 1, height: '16px', display: 'flex', alignItems: 'center' }}>
              {events.map((evt, i) => {
                const leftPercent = timeRange > 0 ? ((evt.timestamp - startTime) / timeRange) * 100 : 0;
                return (
                  <div 
                    key={`time-${i}`}
                    style={{
                      position: 'absolute',
                      left: `${leftPercent}%`,
                      width: '4px', height: '10px',
                      backgroundColor: getEventColor(evt.type),
                      transform: 'translateX(-50%)',
                      pointerEvents: 'none', zIndex: 1, opacity: 0.8
                    }}
                    title={`${evt.type} (${evt.source})`}
                  />
                );
              })}
              <input 
                type="range" min={startTime} max={endTime} 
                value={currentTime} 
                onChange={handleTimeSeek}
                style={{ width: '100%', margin: 0, cursor: 'pointer', zIndex: 2, opacity: 0.5 }}
                disabled={events.length === 0}
              />
            </div>
            <span style={{ fontSize: '14px', width: '100px', textAlign: 'right', fontFamily: 'monospace' }}>
              {formatTime(currentTime)}
            </span>
          </div>

        </div>

        {/* 次へボタン */}
        <button 
          onClick={jumpToNext} 
          disabled={currentIndex >= events.length - 1}
          style={{ cursor: currentIndex >= events.length - 1 ? 'not-allowed' : 'pointer', padding: '0 15px' }}
        >
          ▶
        </button>

      </div>

      <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
        <div style={{
          flex: '0 0 30%',
          overflowY: 'auto',
          border: '1px solid #444',
          padding: '10px',
          backgroundColor: '#1e1e1e',
          color: '#d4d4d4',
          borderRadius: '8px'
        }}>
          {events.length === 0 ? (
            <p>トレースイベントを待機中...</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {events.map((evt, index) => (
                <li key={index} style={{ 
                  marginBottom: '8px', 
                  borderBottom: '1px solid #333', 
                  paddingBottom: '4px',
                  backgroundColor: index === currentIndex ? '#334433' : 'transparent',
                  padding: index === currentIndex ? '4px' : '0 0 4px 0',
                  borderRadius: '4px'
                }}>
                  <span style={{ color: getEventColor(evt.type), fontWeight: 'bold' }}>[{evt.type}]</span>{' '}
                  <span>{evt.source}</span>
                  {evt.target && <span style={{ color: '#569CD6' }}> -&gt; {evt.target}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{
          flex: 1,
          border: '1px solid #ccc',
          borderRadius: '8px',
          backgroundColor: '#f9f9f9'
        }}>
          <ReactFlow 
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
          >
            <Background color="#ccc" gap={16} />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}

// ReactFlowProvider でラップしてエクスポート
export default function App() {
  return (
    <ReactFlowProvider>
      <TraceViewer />
    </ReactFlowProvider>
  )
}