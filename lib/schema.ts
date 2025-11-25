import { Row, SchemaColumn } from "./types";

export type InferredColumn = {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
};

export function inferSchema(rows: Row[]): InferredColumn[] {
  if (!rows.length) return [];

  // Build unique column set once so we only scan rows per column.
  const columnNames = new Set<string>();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => columnNames.add(key));
  });

  return Array.from(columnNames).map((name) => {
    let nullable = false;
    let hasValue = false;
    let numeric = true;
    let integer = true;
    let hasNumericSample = false;
    let dateLike = true;
    let hasDateSample = false;
    let booleanLike = true;
    let hasBooleanSample = false;
    let maxLength = 0;
    let minNumeric = Number.POSITIVE_INFINITY;
    let maxNumeric = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      if (!(name in row)) continue;
      const value = row[name];

      if (value === undefined) continue;

      if (value === null || value === "") {
        nullable = true;
        continue;
      }

      hasValue = true;

      const str = typeof value === "string" ? value : String(value);
      if (str.length > maxLength) {
        maxLength = str.length;
      }

      const num = Number(value);
      if (Number.isNaN(num)) {
        numeric = false;
        integer = false;
      } else {
        hasNumericSample = true;
        if (num < minNumeric) minNumeric = num;
        if (num > maxNumeric) maxNumeric = num;
        if (!Number.isInteger(num)) integer = false;
      }

      const lower = str.trim().toLowerCase();
      if (lower.length) {
        const isBooleanToken = ["true", "false", "0", "1"].includes(lower);
        if (isBooleanToken) {
          hasBooleanSample = true;
        } else {
          booleanLike = false;
        }
      } else {
        booleanLike = false;
      }

      const parsed = Date.parse(str);
      if (Number.isNaN(parsed)) {
        dateLike = false;
      } else {
        hasDateSample = true;
      }
    }

    let type = "VARCHAR";

    if (hasValue) {
      if (numeric && integer && hasNumericSample) {
        if (minNumeric >= -32768 && maxNumeric <= 32767) type = "SMALLINT";
        else if (minNumeric >= -2147483648 && maxNumeric <= 2147483647) type = "INTEGER";
        else type = "BIGINT";
      } else if (numeric && hasNumericSample) {
        type = "DECIMAL";
      } else if (dateLike && hasDateSample) {
        type = "TIMESTAMP";
      } else if (booleanLike && hasBooleanSample) {
        type = "BOOLEAN";
      } else {
        if (maxLength <= 255) type = "VARCHAR";
        else type = "TEXT";
      }
    }

    return {
      name,
      type,
      nullable,
      ...(type === "VARCHAR" ? { maxLength: Math.max(maxLength, 255) } : {}),
    };
  });
}

export function generateCreateTableSQL(tableName: string, columns: InferredColumn[], dbType: 'postgres' | 'mysql' | 'mssql' | 'oracle'): string {
  const typeMap: Record<string, Record<string, string>> = {
    postgres: {
      VARCHAR: (col) => `VARCHAR(${col.maxLength})`,
      TEXT: () => 'TEXT',
      SMALLINT: () => 'SMALLINT',
      INTEGER: () => 'INTEGER',
      BIGINT: () => 'BIGINT',
      DECIMAL: () => 'DECIMAL(18,2)',
      TIMESTAMP: () => 'TIMESTAMP',
      BOOLEAN: () => 'BOOLEAN'
    },
    mysql: {
      VARCHAR: (col) => `VARCHAR(${col.maxLength})`,
      TEXT: () => 'TEXT',
      SMALLINT: () => 'SMALLINT',
      INTEGER: () => 'INT',
      BIGINT: () => 'BIGINT',
      DECIMAL: () => 'DECIMAL(18,2)',
      TIMESTAMP: () => 'DATETIME',
      BOOLEAN: () => 'TINYINT(1)'
    },
    mssql: {
      VARCHAR: (col) => `VARCHAR(${col.maxLength})`,
      TEXT: () => 'TEXT',
      SMALLINT: () => 'SMALLINT',
      INTEGER: () => 'INT',
      BIGINT: () => 'BIGINT',
      DECIMAL: () => 'DECIMAL(18,2)',
      TIMESTAMP: () => 'DATETIME2',
      BOOLEAN: () => 'BIT'
    },
    oracle: {
      VARCHAR: (col) => `VARCHAR2(${col.maxLength})`,
      TEXT: () => 'CLOB',
      SMALLINT: () => 'NUMBER(5)',
      INTEGER: () => 'NUMBER(10)',
      BIGINT: () => 'NUMBER(19)',
      DECIMAL: () => 'NUMBER(18,2)',
      TIMESTAMP: () => 'TIMESTAMP',
      BOOLEAN: () => 'NUMBER(1)'
    }
  };

  const columnDefs = columns.map(col => {
    const typeMapper = typeMap[dbType][col.type] || typeMap[dbType]['VARCHAR'];
    const sqlType = typeMapper(col);
    return `  "${col.name}" ${sqlType}${col.nullable ? '' : ' NOT NULL'}`;
  }).join(',\n');

  switch (dbType) {
    case 'postgres':
      return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${columnDefs}\n);`;
    case 'mysql':
      return `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n${columnDefs}\n);`;
    case 'mssql':
      return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${tableName}')\nBEGIN\n  CREATE TABLE [${tableName}] (\n${columnDefs}\n  );\nEND;`;
    case 'oracle':
      // Oracle doesn't have IF NOT EXISTS, so we need to check first
      return `DECLARE\n  v_count NUMBER;\nBEGIN\n  SELECT COUNT(*) INTO v_count FROM user_tables WHERE table_name = UPPER('${tableName}');\n  IF v_count = 0 THEN\n    EXECUTE IMMEDIATE 'CREATE TABLE "${tableName}" (\n${columnDefs}\n    )';\n  END IF;\nEND;`;
    default:
      throw new Error(`Unsupported database type: ${dbType}`);
  }
}
