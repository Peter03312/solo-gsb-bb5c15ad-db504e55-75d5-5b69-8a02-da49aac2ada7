import React from 'react';

const TYPES = ['NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT'];

export default function RecordTable({ records, errors, onChange, canEdit }) {
  const errByIndex = new Map();
  for (const e of errors) {
    if (e.index < 0) continue;
    if (!errByIndex.has(e.index)) errByIndex.set(e.index, []);
    errByIndex.get(e.index).push(e);
  }

  const update = (i, patch) => {
    const next = records.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i) => onChange(records.filter((_, idx) => idx !== i));
  const add = () => onChange([...records, { id: `new-${Date.now()}`, name: '', type: 'A', ttl: 3600, value: '' }]);

  const fieldCls = (i, field) => (errByIndex.get(i) || []).some((e) => e.field === field) ? 'field-error' : '';

  return (
    <div>
      <table className="records-table">
        <thead>
          <tr>
            <th className="col-name">记录名（@ 或相对名）</th>
            <th className="col-type">类型</th>
            <th className="col-ttl">TTL</th>
            <th className="col-pri">MX 优先级</th>
            <th className="col-value">值</th>
            <th className="col-del"></th>
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => {
            const errs = errByIndex.get(i) || [];
            return (
              <tr key={r.id || i} className={errs.length ? 'row-error' : ''}>
                <td>
                  <input className={`mono ${fieldCls(i, 'name')}`} value={r.name} disabled={!canEdit}
                    onChange={(e) => update(i, { name: e.target.value })} placeholder="@ / www / mail" />
                </td>
                <td>
                  <select value={r.type} disabled={!canEdit} onChange={(e) => update(i, { type: e.target.value })}>
                    {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td>
                  <input className={`mono ${fieldCls(i, 'ttl')}`} value={r.ttl} disabled={!canEdit}
                    onChange={(e) => update(i, { ttl: e.target.value })} />
                </td>
                <td>
                  <input className="mono" value={r.type === 'MX' ? (r.priority ?? '') : ''} disabled={!canEdit || r.type !== 'MX'}
                    onChange={(e) => update(i, { priority: e.target.value })} placeholder={r.type === 'MX' ? '10' : ''} />
                </td>
                <td>
                  <input className={`mono ${fieldCls(i, 'value') || fieldCls(i, 'priority')}`} value={r.value} disabled={!canEdit}
                    onChange={(e) => update(i, { value: e.target.value })}
                    placeholder={r.type === 'TXT' ? 'v=spf1 -all' : r.type === 'A' ? '192.0.2.1' : r.type === 'AAAA' ? '2001:db8::1' : 'host.example.org.'} />
                  {errs.length > 0 && (
                    <div className="err-hint">
                      {errs.map((e, k) => <div key={k}>• {e.field === 'type' ? '' : `${e.field}: `}{e.reason}</div>)}
                    </div>
                  )}
                </td>
                <td className="col-del">
                  {canEdit && <button className="danger" style={{ padding: '4px 8px' }} onClick={() => remove(i)}>✕</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canEdit && <div className="btn-row"><button onClick={add}>＋ 添加记录</button></div>}
    </div>
  );
}
