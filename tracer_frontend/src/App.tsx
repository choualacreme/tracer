import { useCallback, useMemo } from 'react';
import { ReactFlow, Background, Controls, Panel } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTraceStream } from './hooks/useTraceStream';
import { getLayoutedElements } from './utils/layout';
import ProcessNode from './components/ProcessNode';
import MessageEdge from './components/MessageEdge';

function App() {
  const { nodes, edges, onNodesChange, onEdgesChange, setNodes, setEdges } = useTraceStream();

  const nodeTypes = useMemo(() => ({ processNode: ProcessNode }), []);
  const edgeTypes = useMemo(() => ({ messageEdge: MessageEdge }), []);

  const onLayout = useCallback(
    (direction: string) => {
      const { layoutedNodes, layoutedEdges } = getLayoutedElements(nodes, edges, direction);
      setNodes([...layoutedNodes]);
      setEdges([...layoutedEdges]);
    },
    [nodes, edges, setNodes, setEdges]
  );

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#f7fafc' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
      >
        <Panel position="top-right" style={{ display: 'flex', gap: '8px' }}>
          <button 
            onClick={() => onLayout('TB')}
            style={{ padding: '8px 16px', background: '#4299e1', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            縦に整列
          </button>
          <button 
            onClick={() => onLayout('LR')}
            style={{ padding: '8px 16px', background: '#48bb78', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            横に整列
          </button>
        </Panel>

        <Background color="#cbd5e0" gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export default App;