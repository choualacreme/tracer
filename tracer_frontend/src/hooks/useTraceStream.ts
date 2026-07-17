import { useEffect } from 'react';
import { useNodesState, useEdgesState, type Node, type Edge } from '@xyflow/react';
import { Socket } from 'phoenix';

export type TraceEvent = {
  type: "SPAWN" | "EXIT" | "SEND" | "RECEIVE";
  source: string | null;
  target: string | null;
  payload: string | null;
  clock: number[];
};

export function useTraceStream(endpointUrl: string = "ws://localhost:4000/socket") {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[]);

  useEffect(() => {
    const socket = new Socket(endpointUrl, { params: {} });
    socket.connect();

    const channel = socket.channel("trace_events:lobby", {});
    
    channel.join()
      .receive("ok", () => console.log("✅ Phoenix Channel 接続成功"))
      .receive("error", (resp: unknown) => console.error("❌ 接続エラー", resp));

    channel.on("new_trace_event", (event: TraceEvent) => {
      
      // 【修正1: 遅延登録システム】
      // イベントに登場したPID（送信元や送信先）が、まだ画面上に存在しない「未知のプロセス」であれば、自動的にノードとして追加する
      setNodes((nds) => {
        const pids = [event.source, event.target].filter((p): p is string => p !== null);
        let added = false;
        const newNds = [...nds];
        
        pids.forEach(pid => {
          if (!newNds.some(n => n.id === pid)) {
            newNds.push({
              id: pid,
              type: 'processNode',
              position: { x: Math.random() * 200, y: newNds.length * 80 }, 
              data: { 
                label: pid,
                clock: event.clock || [],
                status: 'running'
              }
            });
            added = true;
          }
        });
        return added ? newNds : nds;
      });

      // 個別の状態更新（ノードは上記で確実に追加されている前提）
      switch (event.type) {
        case "EXIT": {
          const sourceId = event.source;
          if (sourceId) {
            setNodes((nds) => nds.map(n => {
              if (n.id === sourceId) {
                return {
                  ...n,
                  data: { ...n.data, status: 'crashed', payload: event.payload }
                };
              }
              return n;
            }));
          }
          break;
        }

        case "SEND": {
          const sourceId = event.source;
          const targetId = event.target;
          if (sourceId && targetId) {
            // 【修正2: 一意性の保証】
            // ミリ秒以下の同時実行でもIDが絶対に被らないようにランダム文字列を付加
            const uniqueId = Math.random().toString(36).substring(2, 9);
            const edgeId = `e-${sourceId}-${targetId}-${Date.now()}-${uniqueId}`;
            
            setEdges((eds) => [...eds, {
              id: edgeId,
              source: sourceId,
              target: targetId,
              label: String(event.payload),
              type: 'messageEdge',
              animated: true,
              style: { stroke: '#4299e1', strokeWidth: 2 }
            }]);
          }
          break;
        }

        case "RECEIVE": {
          const sourceId = event.source;
          if (sourceId) {
            setEdges((eds) => eds.map(e => {
              if (e.target === sourceId && e.animated) {
                return { ...e, animated: false, style: { stroke: '#48bb78', strokeWidth: 2 } };
              }
              return e;
            }));
          }
          break;
        }
      }
    });

    return () => {
      channel.leave();
      socket.disconnect();
    };
  }, [endpointUrl, setNodes, setEdges]);

  return { nodes, edges, onNodesChange, onEdgesChange, setNodes, setEdges };
}