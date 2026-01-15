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

      const isDateObject = value instanceof Date;
      if (isDateObject) {
        hasDateSample = true;
        dateLike = true;
        numeric = false;
        integer = false;
        continue;
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

export type DbTypeForSchema = "postgres" | "mysql" | "mssql" | "oracle";

function qualifyTableName(tableName: string, schemaName: string | undefined, dbType: DbTypeForSchema) {
  switch (dbType) {
    case "postgres":
      if (schemaName) return `"${schemaName}"."${tableName}"`;
      return `"${tableName}"`;
    case "mysql":
      return schemaName ? `\`${schemaName}\`.\`${tableName}\`` : `\`${tableName}\``;
    case "mssql":
      if (schemaName) return `[${schemaName}].[${tableName}]`;
      return `[${tableName}]`;
    case "oracle":
      if (schemaName) return `${schemaName.toUpperCase()}.${tableName.toUpperCase()}`;
      return `${tableName.toUpperCase()}`;
    default:
      return tableName;
  }
}

export type CreateTableOptions = {
  allowNullValues?: boolean;
  addAuditColumns?: boolean;
  workflowOwner?: string;
  workflowName?: string;
};

function escapeLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

export function generateCreateTableSQL(
  tableName: string,
  columns: InferredColumn[],
  dbType: DbTypeForSchema,
  schemaName?: string,
  options?: CreateTableOptions
): string {
  const typeMap: Record<string, Record<string, (col: InferredColumn) => string>> = {
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

  const quoteColumn = (name: string) => {
    switch (dbType) {
      case "postgres":
      case "oracle":
        return `"${name}"`;
      case "mysql":
        return `\`${name}\``;
      case "mssql":
        return `[${name}]`;
      default:
        return name;
    }
  };

  const columnLines = columns.map((col) => {
    const typeMapper = typeMap[dbType][col.type] || typeMap[dbType]['VARCHAR'];
    const sqlType = typeMapper(col);
    const allowNull = options?.allowNullValues ? true : col.nullable;
    return `  ${quoteColumn(col.name)} ${sqlType}${allowNull ? '' : ' NOT NULL'}`;
  });

  const normalized = columns.map((col) => col.name.toLowerCase());
  const existingNames = new Set(normalized);

  const timestampInfo: Record<DbTypeForSchema, { type: string; default: string }> = {
    postgres: { type: "TIMESTAMP", default: "CURRENT_TIMESTAMP" },
    mysql: { type: "DATETIME", default: "CURRENT_TIMESTAMP" },
    mssql: { type: "DATETIME2", default: "GETDATE()" },
    oracle: { type: "TIMESTAMP", default: "CURRENT_TIMESTAMP" },
  };

  const ownerTypeMap: Record<DbTypeForSchema, string> = {
    postgres: "VARCHAR(128)",
    mysql: "VARCHAR(128)",
    mssql: "VARCHAR(128)",
    oracle: "VARCHAR2(128)",
  };

  const ownerDefaultMap: Record<DbTypeForSchema, string> = {
    postgres: "CURRENT_USER",
    mysql: "''", // avoid CURRENT_USER() default because it can fail on some MySQL versions; leave empty by default
    mssql: "SYSTEM_USER",
    oracle: "USER",
  };

  const auditDefs: string[] = [];
  if (options?.addAuditColumns) {
    if (!existingNames.has("last_modified_at")) {
      const tsInfo = timestampInfo[dbType];
      auditDefs.push(
        `  ${quoteColumn("last_modified_at")} ${tsInfo.type} DEFAULT ${tsInfo.default}`
      );
    }
    if (!existingNames.has("workflow_created_by")) {
      const ownerLiteral =
        options?.workflowOwner?.trim() ||
        options?.workflowName?.trim() ||
        "";
      const ownerDefaultExpression = ownerLiteral
        ? escapeLiteral(ownerLiteral)
        : ownerDefaultMap[dbType];
      auditDefs.push(
        `  ${quoteColumn("workflow_created_by")} ${ownerTypeMap[dbType]} DEFAULT ${ownerDefaultExpression}`
      );
    }
  }

  const columnDefs = [...columnLines, ...auditDefs];
  const allDefs = columnDefs.join(",\n");

  switch (dbType) {
    case 'postgres':
    return `CREATE TABLE IF NOT EXISTS ${qualifyTableName(tableName, schemaName, dbType)} (\n${allDefs}\n);`;
    case "mysql":
      return `CREATE TABLE IF NOT EXISTS ${qualifyTableName(tableName, schemaName, dbType)} (\n${allDefs}\n);`;
    case "mssql":
      return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${tableName}')\nBEGIN\n  CREATE TABLE ${qualifyTableName(tableName, schemaName, dbType)} (\n${allDefs}\n  );\nEND;`;
    case 'oracle':
      // Oracle doesn't have IF NOT EXISTS, so we need to check first
      const qualified = qualifyTableName(tableName, schemaName, dbType);
      const oracleTable = schemaName ? `${schemaName.toUpperCase()}.${tableName.toUpperCase()}` : tableName.toUpperCase();
      return `DECLARE\n  v_count NUMBER;\nBEGIN\n  SELECT COUNT(*) INTO v_count FROM user_tables WHERE table_name = '${oracleTable}';\n  IF v_count = 0 THEN\n    EXECUTE IMMEDIATE 'CREATE TABLE ${qualified} (\n${allDefs}\n    )';\n  END IF;\nEND;`;
    default:
      throw new Error(`Unsupported database type: ${dbType}`);
  }
}
