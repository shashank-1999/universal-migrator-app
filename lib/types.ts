export type DBType =
  | "csv"
  | "excel"
  | "postgres"
  | "mysql"
  | "mssql"
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

export type MappingItem = { from: string; to: string; cast?: string };
export type Mapping = MappingItem[];

export type Row = Record<string, any>;

export type PipelineSpec = {
  version: 1;
  source: SourceOrDest["config"] & { dbType?: DBType }; // frontend sends {type, config}, /api/run receives source/destination separately
  destination: SourceOrDest["config"] & { dbType?: DBType };
  mapping: Mapping;
};
