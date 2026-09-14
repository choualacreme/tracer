import { formatTime, getEventColor } from '../utils';

const renderProcess = (id, name) => {
  if (!id) return '-';
  if (name && name !== "[]" && !name.startsWith("#PID")) {
    return (
      <div style={{ lineHeight: '1.2' }}>
        <div style={{ fontWeight: 'bold' }}>{name}</div>
        {id.startsWith("#PID") && (
          <div style={{ fontSize: '9.5px', color: '#888', fontFamily: 'monospace' }}>{id}</div>
        )}
      </div>
    );
  }
  return <span style={{ fontFamily: 'monospace', color: '#444', fontWeight: 'bold' }}>{id}</span>;
};

export default function LogPanel({
  filteredEvents,
  currentIndex,
  jumpToIndex,
  setIsPlaying,
  activeTab,
  setActiveTab,
  rfNodes,
  searchQuery,
  setSearchQuery,
  visibleCategories = { app: true, otp: true, system: false, timer: false },
  setVisibleCategories,
  hideAnonymous,
  setHideAnonymous,
  isGroupMode,
  setIsGroupMode,
  visibleEvents,
  setVisibleEvents,
  resetFilters,
  getNormId,
  getFinalName,
  isPanelOpen,
  setIsPanelOpen,
  setIsFocusReleased,
  setCollapsedPools
}) {
  return (
    <div className={`overlay-panel-container ${isPanelOpen ? 'panel-open' : 'panel-closed'}`}>
      <div className="panel-body">
        
        {/* 縦型シークバー (Seq) */}
        <div className="seq-rail">
          <span className="seq-label">Seq</span>
          <div className="seq-track-box">
            <div className="seq-pins-overlay">
              {(() => {
                const step = Math.max(1, Math.floor(filteredEvents.length / 200));
                return filteredEvents.filter((_, i) => i % step === 0).map((evt, i) => (
                  <div key={`seq-${evt.originalIndex}`} className="seq-pin" 
                       style={{ 
                         top: `${((i * step) / Math.max(1, filteredEvents.length - 1)) * 100}%`, 
                         backgroundColor: getEventColor(evt.type, evt.payload) 
                       }} 
                  />
                ));
              })()}
            </div>
            <input 
              type="range" 
              min="0" 
              max={Math.max(0, filteredEvents.length - 1)} 
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

        {/* メインコンテンツ・フィルタ */}
        <div className="panel-main-content">
          <div className="filter-box">
            {/* Type (丸ボタン) */}
            <div className="layers-row">
              <span className="layers-label">Type:</span>
              {Object.keys(visibleEvents).map(type => {
                const isVisible = visibleEvents[type];
                const isExit = type === 'EXIT';
                const bgColor = isVisible 
                  ? (isExit ? 'linear-gradient(135deg, #888888 50%, #F44747 50%)' : getEventColor(type)) 
                  : 'transparent';
                const borderColor = isVisible ? (isExit ? '#888888' : getEventColor(type)) : '#444';

                return (
                  <button 
                    key={type} 
                    onClick={() => { setVisibleEvents(p => ({...p, [type]: !p[type]})); setIsFocusReleased(true); }} 
                    className="layer-tag-btn" 
                    style={{ background: bgColor, color: isVisible ? '#fff' : '#666', border: `1px solid ${borderColor}` }}
                  >
                    {type}
                  </button>
                );
              })}
            </div>

            {/* 区切り線 */}
            <div className="filter-divider" />

            {/* Category (四角ボタン) */}
            <div className="layers-row">
              <span className="layers-label">Category:</span>
              {[
                { id: 'app', label: 'APP' },
                { id: 'otp', label: 'OTP' },
                { id: 'system', label: 'SYSTEM' },
                { id: 'timer', label: 'TIMER' }
              ].map(cat => {
                const isVisible = !!visibleCategories[cat.id];
                return (
                  <button
                    key={cat.id}
                    onClick={() => {
                      setVisibleCategories(p => ({ ...p, [cat.id]: !p[cat.id] }));
                      setIsFocusReleased(true);
                    }}
                    className={`category-tag-btn cat-btn-${cat.id} ${isVisible ? 'active' : 'inactive'}`}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>

            {/* 検索・オプション行 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="search-row">
                <input 
                  type="text" 
                  placeholder="🔍 モジュール名、PID、Payloadで検索..." 
                  value={searchQuery} 
                  onChange={(e) => { setSearchQuery(e.target.value); setIsFocusReleased(true); }} 
                  className="search-input" 
                />
                <button onClick={resetFilters} className="search-reset-btn">リセット</button>
              </div>
              <div className="options-row">
                <label className="checkbox-label">
                  <input type="checkbox" checked={hideAnonymous} onChange={(e) => { setHideAnonymous(e.target.checked); setIsFocusReleased(true); }} /> 
                  無名プロセスを隠す
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={isGroupMode} onChange={(e) => { 
                    setIsGroupMode(e.target.checked); 
                    setCollapsedPools(new Set()); 
                    setIsFocusReleased(true); 
                    if (searchQuery.startsWith('pool-')) setSearchQuery(""); 
                  }} /> 
                  同種プロセスをまとめる
                </label>
              </div>
            </div>
          </div>

          <div className="table-tabs-container">
            <div className="tabs-header">
              <div onClick={() => setActiveTab('logs')} className={`tab-btn ${activeTab === 'logs' ? 'tab-active-logs' : 'tab-inactive'}`}>Trace Logs</div>
              <div onClick={() => setActiveTab('states')} className={`tab-btn ${activeTab === 'states' ? 'tab-active-states' : 'tab-inactive'}`}>Current States</div>
            </div>
            
            <div id="log-table-container" className="table-scroll-area">
              {activeTab === 'logs' ? (
                <table className="data-table">
                  {/* テーブルヘッダーとデータ行 */}
                  <thead className="data-table-head">
                    <tr>
                      <th className="th-pt">PT (実時間)</th>
                      <th className="th-lt">LT</th>
                      <th className="th-cat">Category</th>
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
                      const cat = evt.category || 'app';
                      
                      return (
                        <tr id={`log-row-${evt.originalIndex}`} key={evt.originalIndex} 
                            onClick={() => { setIsPlaying(false); jumpToIndex(evt.originalIndex); }} 
                            className={`log-row ${isSelected ? 'log-row-selected' : ''}`}
                        >
                          <td className="col-pt">{showPT ? formatTime(evt.timestamp) : ''}</td>
                          <td className="col-lt">{evt.logicalCounter}</td>
                          <td className="col-cat">
                            <span className={`cat-badge cat-${cat}`}>{cat}</span>
                          </td>
                          <td className="col-type" style={{ color: getEventColor(evt.type, evt.payload) }}>{evt.type}</td>
                          <td className="col-process">{renderProcess(normSource, finalSourceName)}</td>
                          <td className="col-process">{renderProcess(normTarget, finalTargetName)}</td>
                          <td className={`col-payload ${isSelected ? 'col-payload-expand' : 'col-payload-clamp'}`} 
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
                  <thead className="data-table-head">
                    <tr><th style={{ width: '30%' }}>Process</th><th>Current State (Full)</th></tr>
                  </thead>
                  <tbody>
                    {rfNodes
                      .filter(n => !n.hidden && !n.data?.isGroupBoundingBox)
                      .filter(n => searchQuery === "" || (n.data.rawName || "").toLowerCase().includes(searchQuery.toLowerCase()) || n.id.toLowerCase().includes(searchQuery.toLowerCase()))
                      .map(node => (
                        <tr key={`state-${node.id}`} className="log-row">
                          <td className="col-process" style={{ color: '#fff', verticalAlign: 'top' }}>
                            <div style={{ fontWeight: 'bold' }}>{node.data.rawName || 'Anonymous'}</div>
                            <div style={{ fontSize: '9.5px', color: '#888', fontFamily: 'monospace' }}>{node.id}</div>
                          </td>
                          <td className="col-payload" style={{ color: '#DCDCAA', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                            {node.data.currentState || 'No state recorded'}
                          </td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
      <div onClick={() => setIsPanelOpen(!isPanelOpen)} className="panel-toggle-tab">{isPanelOpen ? '◀' : '▶'}</div>
    </div>
  );
}