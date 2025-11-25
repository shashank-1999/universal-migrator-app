"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import styles from "./page.module.css";
import type { SavedQuery } from "./types";

const DATABASE_OPTIONS = [
  { value: "", label: "-- Select Database Type --" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mssql", label: "SQL Server" },
  { value: "oracle", label: "Oracle" },
  { value: "azure_sql", label: "Azure SQL Database" },
  { value: "azure_cosmos", label: "Azure Cosmos DB" },
  { value: "aws_rds", label: "AWS RDS" },
  { value: "aws_aurora", label: "AWS Aurora" },
  { value: "aws_redshift", label: "AWS Redshift" },
  { value: "gcp_cloud_sql", label: "Google Cloud SQL" },
  { value: "gcp_spanner", label: "Google Cloud Spanner" },
  { value: "gcp_bigquery", label: "Google BigQuery" },
];

export default function QueryPage() {
  // State declarations
  const [dbType, setDbType] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, any>[]>([]);
  const [resultMeta, setResultMeta] = useState<{ totalRows?: number; truncated?: boolean; maxRows?: number }>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [recentQueries, setRecentQueries] = useState<SavedQuery[]>([]);
  const [selectedSavedQuery, setSelectedSavedQuery] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [queryName, setQueryName] = useState("");

  // Validation function
  const validateFields = useCallback(() => {
    if (!dbType) return "Database type is required";
    if (!host) return "Host is required";
    if (!port) return "Port is required";
    if (!database) return "Database name is required";
    if (!username) return "Username is required";
    if (!password) return "Password is required";
    return "";
  }, [dbType, host, port, database, username, password]);

  // Query execution
  const handleExecute = useCallback(async () => {
    setError("");
    setResults([]);
    setResultMeta({});
    
    const validationError = validateFields();
    if (validationError) {
      setError(validationError);
      return;
    }
    
    if (!query.trim()) {
      setError("Query cannot be empty");
      return;
    }

    setLoading(true);
    try {
      const body = { type: dbType, config: { host, port, database, user: username, password }, query };
      const res = await fetch("/api/execute-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Status ${res.status}`);
      }

      const data = await res.json();
      let nextRows: Record<string, any>[] = [];
      let totalRows: number | undefined;
      let truncated = false;
      let maxRows: number | undefined;

      if (Array.isArray(data)) {
        nextRows = data;
      } else if (data && Array.isArray(data.rows)) {
        nextRows = data.rows;
        totalRows = typeof data.totalRows === "number" ? data.totalRows : undefined;
        truncated = Boolean(data.truncated);
        maxRows = typeof data.maxRows === "number" ? data.maxRows : undefined;
      }

      setResults(nextRows);
      setResultMeta({
        totalRows: totalRows ?? nextRows.length,
        truncated,
        maxRows,
      });
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [dbType, host, port, database, username, password, query, validateFields]);

  // Load saved queries
  const loadSavedQueries = useCallback(async () => {
    try {
      const response = await fetch('/api/saved-queries');
      if (response.ok) {
        const queries = await response.json();
        setRecentQueries(queries);
      }
    } catch (error) {
      console.error('Error loading saved queries:', error);
    }
  }, []);

  // Load saved queries on mount
  useEffect(() => {
    loadSavedQueries();
  }, [loadSavedQueries]);

  // Save query with name
  const saveQueryWithName = useCallback(async () => {
    if (!queryName.trim() || !query.trim()) return;

    try {
      const newQuery = {
        name: queryName,
        query: query,
        dbType: dbType,
      };

      const response = await fetch('/api/saved-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newQuery),
      });

      if (response.ok) {
        setQueryName('');
        setShowSaveDialog(false);
        loadSavedQueries();
      }
    } catch (error) {
      console.error('Error saving query:', error);
    }
  }, [queryName, query, dbType, loadSavedQueries]);

  // Delete saved query
  const deleteQuery = useCallback(async (id: string) => {
    try {
      await fetch('/api/saved-queries', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      loadSavedQueries();
    } catch (error) {
      console.error('Error deleting query:', error);
    }
  }, [loadSavedQueries]);



  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleExecute();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        setShowSaveDialog(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleExecute]);

  // Save query to recent queries
  const saveQuery = useCallback(() => {
    const newQuery: SavedQuery = {
      id: Date.now().toString(),
      name: query.split('\n')[0].slice(0, 50),
      query,
      dbType,
      createdAt: new Date().toISOString()
    };
    const updated = [newQuery, ...recentQueries].slice(0, 10);
    setRecentQueries(updated);
    localStorage.setItem('recentQueries', JSON.stringify(updated));
  }, [query, dbType, recentQueries]);

  // Load recent queries from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('recentQueries');
    if (saved) {
      try {
        setRecentQueries(JSON.parse(saved));
      } catch (e) {
        console.error('Error loading recent queries:', e);
      }
    }
  }, []);



  // Export results to CSV
  const exportResults = useCallback(() => {
    if (!results?.length) return;
    
    const headers = Object.keys(results[0]);
    const csvContent = [
      headers.join(','),
      ...results.map(row => headers.map(key => JSON.stringify(row[key])).join(','))
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `query_results_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [results]);

  const handleTestConnection = useCallback(async () => {
    setError("");
    const validationError = validateFields();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      const body = { type: dbType, config: { host, port, database, user: username, password } };
      const res = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Status ${res.status}`);
      }

      setError("Connection successful!");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [dbType, host, port, database, username, password, validateFields]);

  // handleExecute is defined above as a useCallback

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.headerTitle}>SQL Query Editor</h1>
        <p className={styles.headerSubtitle}>Execute SQL queries against your databases</p>
      </div>

      <div className={styles.gridContainer}>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Database Connection</h2>
          </div>
          <div className={styles.cardContent}>
            <div className={styles.formContainer}>
              <Select
                label="Database Type"
                value={dbType}
                onChange={(e) => setDbType(e.target.value)}
                options={DATABASE_OPTIONS}
              />

              <Input
                label="Host"
                placeholder="e.g., localhost or db.example.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />

              <Input
                label="Port"
                placeholder="e.g., 5432, 3306"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />

              <Input
                label="Database"
                placeholder="Enter database name"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
              />

              <Input
                label="Username"
                placeholder="Enter database username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />

              <Input
                label="Password"
                type="password"
                placeholder="Enter database password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              <button className={styles.button} onClick={handleTestConnection} disabled={loading}>
                {loading ? (
                  <>
                    <div className={styles.loadingSpinner} /> Testing...
                  </>
                ) : (
                  "Test Connection"
                )}
              </button>
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>SQL Query</h2>
            <div className={styles.cardSubtitle}>Write your SQL query below</div>
          </div>
          <div className={styles.cardContent}>
            <div className={styles.formContainer}>
              <div className={styles.queryControls}>
                <div className={styles.saveQueryForm}>
                  <Input
                    label="Query Name"
                    value={queryName}
                    onChange={(e) => setQueryName(e.target.value)}
                    placeholder="Enter a name for your query"
                  />
                  <button 
                    className={styles.saveButton} 
                    onClick={saveQueryWithName}
                    disabled={!queryName.trim() || !query.trim()}
                  >
                    Save Query
                  </button>
                </div>

                <Select
                  label="Saved Queries"
                  value={selectedSavedQuery}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedSavedQuery(id);
                    const saved = recentQueries.find(q => q.id === id);
                    if (saved) {
                      setQuery(saved.query);
                      if (saved.dbType) setDbType(saved.dbType);
                    }
                  }}
                  options={[
                    { value: "", label: "-- Select Saved Query --" },
                    ...recentQueries.map(q => ({
                      value: q.id,
                      label: `${q.name} (${q.dbType})`
                    }))
                  ]}
                />
                <button
                  className={styles.deleteButton}
                  onClick={() => {
                    if (selectedSavedQuery) {
                      deleteQuery(selectedSavedQuery);
                      setSelectedSavedQuery("");
                    }
                  }}
                  disabled={!selectedSavedQuery}
                  style={{ marginLeft: 8 }}
                >
                  Delete Selected
                </button>
              </div>
              <textarea
                className={styles.queryTextarea}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={8}
                placeholder="SELECT * FROM your_table WHERE condition = true;"
              />

              {error && (
                <div className={`${styles.error} ${error === "Connection successful!" ? styles.success : ""}`}>
                  <svg className={styles.errorIcon} viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <div className={styles.errorMessage}>{error}</div>
                </div>
              )}

              <button className={styles.button} onClick={handleExecute} disabled={loading}>
                {loading ? (
                  <>
                    <div className={styles.loadingSpinner} /> Executing...
                  </>
                ) : (
                  "Execute Query"
                )}
              </button>
            </div>
          </div>
        </div>

        {results.length > 0 && (
          <div className={`${styles.card} ${styles.resultsCard}`}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Query Results</h2>
              <div className={styles.resultsHeader}>
                <div className={styles.cardSubtitle}>
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M7 3a1 1 0 000 2h6a1 1 0 100-2H7zM4 7a1 1 0 011-1h10a1 1 0 110 2H5a1 1 0 01-1-1zM2 11a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4z" />
                  </svg>
                  {results.length} row{results.length !== 1 ? "s" : ""} returned
                  {resultMeta.totalRows && resultMeta.totalRows !== results.length
                    ? ` of ${resultMeta.totalRows}`
                    : ""}
                </div>
                <button className={styles.exportButton} onClick={exportResults}>
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" />
                  </svg>
                  Export CSV
                </button>
              </div>
            </div>
            <div className={styles.cardContent}>
              {resultMeta.truncated && (
                <div className={styles.truncatedNotice}>
                  Showing first {(resultMeta.maxRows ?? results.length).toLocaleString()} of{" "}
                  {(resultMeta.totalRows ?? results.length).toLocaleString()} rows. Add a WHERE clause
                  or LIMIT to narrow the result set.
                </div>
              )}
              <div className={styles.resultsTableWrapper}>
                <div className={styles.scrollHint}>Scroll to view additional rows</div>
                <table className={styles.table}>
                  <thead className={styles.tableHeader}>
                    <tr>
                      {Object.keys(results[0]).map((k) => (
                          <th key={k} className={styles.tableHeaderCell}>
                            {k}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={i} className={styles.tableRow}>
                        {Object.values(r).map((v: any, j) => (
                          <td key={j} className={styles.tableCell}>
                            {v?.toString?.() ?? String(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
