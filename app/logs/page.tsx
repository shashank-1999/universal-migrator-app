"use client";
import { useEffect, useState } from "react";

type Run = {
  runId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  rowsRead?: number;
  rowsWritten?: number;
  durationMs?: number;
  outputUrl?: string;
};

export default function LogsPage() {
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(()=>{
    (async ()=>{
      const res = await fetch("/api/runs");
      const json = await res.json();
      setRuns(json.runs || []);
    })();
  }, []);

  return (
    <main>
      <h1 style={{fontSize:22, fontWeight:700, marginBottom:12}}>Logs</h1>
      <table style={{borderCollapse:'collapse', width:'100%'}}>
        <thead><tr><th>Run ID</th><th>Status</th><th>Rows</th><th>Duration</th><th>Started</th><th>Output</th><th>Download log</th></tr></thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.runId}>
              <td>{r.runId}</td>
              <td>{r.status}</td>
              <td>{r.rowsWritten ?? r.rowsRead ?? "-"}</td>
              <td>{r.durationMs ? Math.round(r.durationMs/1000)+'s' : '-'}</td>
              <td>{r.startedAt || '-'}</td>
              <td>{r.outputUrl ? <a href={r.outputUrl} target="_blank">file</a> : '-'}</td>
              <td><a href={`/api/runs/${r.runId}/log`} target="_blank">.jsonl</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}