export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  dbType: string;
  createdAt: string;
}

export interface QueryTemplate {
  id: string;
  name: string;
  description: string;
  query: string;
  dbType: string;
}

export const QUERY_TEMPLATES: QueryTemplate[] = [
  {
    id: 'list-tables',
    name: 'List All Tables',
    description: 'Shows all tables in the current database',
    query: `SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public'
ORDER BY table_name;`,
    dbType: 'postgres'
  },
  {
    id: 'table-columns',
    name: 'Table Columns',
    description: 'Shows column details for a specific table',
    query: `SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'your_table'
ORDER BY ordinal_position;`,
    dbType: 'postgres'
  },
  {
    id: 'table-size',
    name: 'Table Sizes',
    description: 'Shows the size of all tables',
    query: `SELECT 
    table_name,
    pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as total_size
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY pg_total_relation_size(quote_ident(table_name)) DESC;`,
    dbType: 'postgres'
  }
];