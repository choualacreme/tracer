import { getEventColor } from '../utils';

export default function TraceTooltip({
  tooltip,
  events,
  currentIndex,
  masterData,
  rfEdges,
  getEffectiveId,
  getNormId,
  getFinalName
}) {
  if (!tooltip) return null;

  if (tooltip.type === 'node') {
    const node = masterData.nodes.find(n => n.id === tooltip.id);
    if (!node) return null;

    let lastEvtType = 'NONE';
    let lastEvtPayload = null;
    let parentId = '-';
    let parentName = null;
    let sendCount = 0;
    let receiveCount = 0;
    let spawnCount = 0;
    let localCount = 0;

    for (let i = 0; i <= currentIndex; i++) {
      const ev = events[i];
      if (!ev) continue;

      const isSource = getEffectiveId(getNormId(ev.source)) === tooltip.id;
      const isTarget = getEffectiveId(getNormId(ev.target)) === tooltip.id;

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

      if (isSource || isTarget) {
        lastEvtType = ev.type;
        lastEvtPayload = ev.payload;
      }
    }

    const displayState = (node.data.currentState || 'N/A').length > 200
      ? (node.data.currentState || 'N/A').substring(0, 200) + ' ... '
      : (node.data.currentState || 'N/A');

    return (
      <div className="floating-tooltip" style={{ top: tooltip.y + 15, left: tooltip.x + 15 }}>
        <div className="tooltip-header">
          <span className="tooltip-title" style={{ color: getEventColor(lastEvtType, lastEvtPayload) }}>
            {node.data.rawName || 'Anonymous'}
          </span>
          <span className="tooltip-pid">{tooltip.id}</span>
        </div>
        <div style={{ marginBottom: '8px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div>
            Parent: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>
              {parentName && parentName !== parentId && parentName !== "[]" && !parentName.startsWith("#PID") 
                ? `${parentName} (${parentId})` 
                : parentId}
            </span>
          </div>
          <div>
            <div style={{ marginBottom: '2px', color: '#999' }}>Activity:</div>
            <div className="tooltip-grid-activities">
              <div><span style={{ color: getEventColor('SEND') }}>SEND</span>: {sendCount}</div>
              <div><span style={{ color: getEventColor('RECEIVE') }}>RECEIVE</span>: {receiveCount}</div>
              <div><span style={{ color: getEventColor('SPAWN') }}>SPAWN</span>: {spawnCount}</div>
              <div><span style={{ color: getEventColor('LOCAL EVENT') }}>LOCAL EVENT</span>: {localCount}</div>
            </div>
          </div>
          <div>
            Last Event: <span style={{ color: getEventColor(lastEvtType, lastEvtPayload), fontWeight: 'bold', backgroundColor: 'rgba(255,255,255,0.1)', padding: '2px 6px', borderRadius: '4px' }}>
              {lastEvtType}
            </span>
          </div>
        </div>
        <div className="tooltip-state-box">{displayState}</div>
      </div>
    );
  } else {
    const aggEdge = rfEdges.find(e => e.id === tooltip.id);
    if (!aggEdge) return null;
    
    const typesArr = Array.from(aggEdge.data.types);
    
    return (
      <div className="floating-tooltip" style={{ top: tooltip.y + 15, left: tooltip.x + 15 }}>
        <div className="tooltip-header" style={{ fontWeight: 'bold', fontSize: '14px' }}>
          {typesArr.map((t, i) => (
            <span key={t}>
              <span style={{ color: getEventColor(t) }}>{t}</span>
              {i < typesArr.length - 1 ? <span style={{ color: '#666', margin: '0 4px' }}>/</span> : ''}
            </span>
          ))}
        </div>
        <div style={{ marginBottom: '6px', fontSize: '11px', color: '#999', fontStyle: 'italic' }}>▼ Latest Communication</div>
        <div style={{ marginBottom: '4px', fontSize: '12px' }}>
          Type: <span style={{ color: getEventColor(aggEdge.data.latestType), fontWeight: 'bold' }}>{aggEdge.data.latestType}</span>
        </div>
        <div style={{ marginBottom: '4px', fontSize: '12px' }}>
          From: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{aggEdge.source}</span>
        </div>
        <div style={{ marginBottom: '4px', fontSize: '12px' }}>
          To: <span style={{ color: '#ccc', fontFamily: 'monospace' }}>{aggEdge.target}</span>
        </div>
        <div className="tooltip-state-box">{aggEdge.data.currentPayload}</div>
      </div>
    );
  }
}