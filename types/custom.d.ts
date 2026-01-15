declare module "oracledb" {
  const oracledb: any;
  export default oracledb;
}

declare module "oracledb/promises" {
  const oracledb: any;
  export default oracledb;
}

// Fallback for any other native modules without types used in the repo
declare module "oracledb/*" {
  const x: any;
  export default x;
}

declare module "parquetjs-lite" {
  const ParquetSchema: any;
  const ParquetReader: any;
  const ParquetWriter: any;
  export { ParquetSchema, ParquetReader, ParquetWriter };
}
