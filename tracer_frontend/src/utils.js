import dagre from 'dagre';

export const nodeWidth = 150;
export const nodeHeight = 40;

export const getLayoutedElements = (nodes, edges, groupMembers, isPoolCollapsedFn) => {
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

      const startX = poolMeta.x - rowWidth / 2;
      const startY = (poolMeta.y - dim.height / 2) + PAD_Y + 10;

      layoutedNodes.push({
        ...node,
        targetPosition: 'top',
        sourcePosition: 'bottom',
        position: { x: startX + col * COL_GAP - 10, y: startY + row * ROW_GAP - 10 },
      });
    } else {
      const nodeWithPos = dagreGraph.node(node.id);
      const w = parseInt(node.style?.width || nodeWidth, 10);
      const h = parseInt(node.style?.height || nodeHeight, 10);
      layoutedNodes.push({
        ...node,
        targetPosition: 'top',
        sourcePosition: 'bottom',
        position: { x: nodeWithPos.x - w / 2, y: nodeWithPos.y - h / 2 },
      });
    }
  });

  return { nodes: layoutedNodes, edges };
};

export const getEventColor = (type, payload = null) => {
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

export const formatTime = (ts) => {
  if (!ts) return "00:00:00.000";
  const d = new Date(ts);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

export const extractSignature = (payload) => {
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