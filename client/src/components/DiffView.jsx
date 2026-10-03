import React from 'react';

function fmt(r, sign) {
  const pri = r.type === 'MX' ? `${r.priority} ` : '';
  return (
    <tr key={sign + r.name + r.type + r.value + r.ttl} className={sign === '+' ? 'diff-add' : 'diff-del'}>
      <td className="mono">{r.name || '@'}</td>
      <td>{r.ttl}</td>
      <td>IN</td>
      <td>{r.type}</td>
      <td className="mono">{pri}{r.value}</td>
    </tr>
  );
}

export default function DiffView({ diff }) {
  if (!diff) return <div className="muted small">差异加载中…</div>;
  if (!diff.hasChanges) {
    return (
      <div className="alert ok small">
        {diff.fromExists ? '当前草稿与现行发布版无差异。' : '尚无发布版本，当前内容将作为首个发布版本。'}
      </div>
    );
  }
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        {diff.from ? `相对现行发布版 序列号 ${diff.from.serial}` : '相对空发布（首次发布）'} → {diff.to.label}
      </div>
      {diff.header.length > 0 && (
        <table style={{ marginBottom: 10 }}>
          <thead><tr><th>字段</th><th>现值</th><th>草稿</th></tr></thead>
          <tbody>
            {diff.header.map((h) => (
              <tr key={h.field}>
                <td>{h.label}</td>
                <td className="mono diff-del">{h.from || '—'}</td>
                <td className="mono diff-add">{h.to || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table>
        <thead><tr><th>名称</th><th>TTL</th><th>类</th><th>类型</th><th>值</th></tr></thead>
        <tbody>
          {diff.removed.map((r) => fmt(r, '-'))}
          {diff.added.map((r) => fmt(r, '+'))}
        </tbody>
      </table>
    </div>
  );
}
