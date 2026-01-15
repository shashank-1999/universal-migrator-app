export type DBType =
  | "csv"
  | "excel"
  | "json"
  | "parquet"
  | "postgres"
  | "mysql"
  | "mssql"
  | "oracle"
  | "minio"
  | "s3"
  | "gcs"
  | "azureBlob";

export type SchemaColumn = { name: string; type: string };

export type SourceOrDest = {
  kind: "source" | "destination";
  label: string;
  dbType: DBType;
  config: Record<string, any>;
};

export type CastType = "STRING" | "NUMBER" | "BOOLEAN" | "DATE";

export type ComparisonOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "greaterThan"
  | "lessThan"
  | "isEmpty"
  | "isNotEmpty";

export type ColumnCondition = {
  field?: string;
  operator: ComparisonOperator;
  value?: string;
  thenValue?: string;
  elseValue?: string;
};

export type ColumnConcat = {
  sources: string[];
  separator?: string;
};

export type ColumnSplit = {
  delimiter: string;
  partIndex: number;
};

export type ColumnMapping = {
  from: string;
  to: string;
  trim?: boolean;
  cast?: CastType;
  condition?: ColumnCondition;
  concat?: ColumnConcat;
  split?: ColumnSplit;
  sourceType?: string;
  destType?: string;
};

export type TransformFilter = {
  id: string;
  field: string;
  operator: ComparisonOperator;
  value?: string;
  action: "keep" | "discard";
};

export type Mapping = ColumnMapping[];

export type Row = Record<string, any>;

export type PipelineSpec = {
  version: 1;
  source: SourceOrDest["config"] & { dbType?: DBType }; // frontend sends {type, config}, /api/run receives source/destination separately
  destination: SourceOrDest["config"] & { dbType?: DBType };
  mapping: Mapping;
};
