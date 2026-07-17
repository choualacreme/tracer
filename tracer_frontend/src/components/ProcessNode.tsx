import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export type ProcessNodeData = {
  label: string;
  clock: number[];
  status: 'running' | 'crashed';
  payload?: string;
};

export type ProcessNodeType = Node<ProcessNodeData, 'processNode'>;

export default function ProcessNode({ data }: NodeProps<ProcessNodeType>) {
  const isCrashed = data.status === 'crashed';
  const bgColor = isCrashed ? '#f56565' : '#4fd1c5';

  return (
    <div style={{
      background: bgColor,
      color: 'white',
      padding: '12px',
      borderRadius: '8px',
      fontFamily: 'monospace',
      width: '200px',
      boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
      border: isCrashed ? '2px solid #c53030' : '2px solid #319795',
      wordBreak: 'break-all'
    }}>
      <Handle type="target" position={Position.Top} />
      
      <div style={{ fontSize: '10px', opacity: 0.8, textTransform: 'uppercase' }}>Process ID</div>
      <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px' }}>{data.label}</div>
      
      <div style={{ fontSize: '10px', opacity: 0.8, textTransform: 'uppercase' }}>Logical Clock</div>
      <div style={{ 
        background: 'rgba(0,0,0,0.2)', 
        padding: '4px 6px', 
        borderRadius: '4px', 
        fontSize: '12px',
        letterSpacing: '1px',
        maxHeight: '60px',
        overflowY: 'auto'
      }}>
        [{data.clock ? data.clock.join(', ') : ''}]
      </div>

      {isCrashed && data.payload && (
        <div style={{ marginTop: '8px', fontSize: '10px', background: 'rgba(255,255,255,0.2)', padding: '4px', borderRadius: '4px' }}>
          [ERROR] {data.payload}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}