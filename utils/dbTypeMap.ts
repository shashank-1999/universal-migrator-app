export function mapDbTypeToBackend(t: string) {
  return (
    {
      PostgreSQL: "postgres",
      MySQL: "mysql",
      MSSQL: "mssql",
      Oracle: "oracle",
      CSV: "csv",
      Excel: "excel",
    }[t] ?? t
  );
}
