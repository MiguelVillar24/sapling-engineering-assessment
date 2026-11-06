import { useEffect, useState } from 'react';
import { exportAll } from '../lib/api';

/** Every stored record, straight from SQLite (GET /api/export), so a reviewer can inspect state after a restart. */
export function Records() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => exportAll().then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const sections = data ? (['conversations', 'messages', 'requests', 'agent_runs'] as const) : [];
  return (
    <div className="records">
      <div className="row-between">
        <div>
          <h2>Stored records</h2>
          <p className="muted">
            Raw contents of the local SQLite database (<code>server/var/sapling.db</code>). Also available as JSON at <code>/api/export</code> or in
            a terminal with <code>npm run inspect</code>.
          </p>
        </div>
        <button onClick={load}>Reload</button>
      </div>
      {error && <p className="error">{error}</p>}
      {data &&
        sections.map((k) => (
          <details key={k} open={k === 'requests'}>
            <summary>
              {k} ({Array.isArray(data[k]) ? (data[k] as unknown[]).length : 0})
            </summary>
            <pre>{JSON.stringify(data[k], null, 2)}</pre>
          </details>
        ))}
    </div>
  );
}
