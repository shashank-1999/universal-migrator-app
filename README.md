# Universal Migrator (MVP)

Minimal working starter with:
- Pages: **Home**, **Workflow**, **Logs** (Scheduling placeholder)
- Sources: **CSV**, **Postgres (read)**
- Destinations: **CSV**
- **Schema fetch**, **Mapping & basic casts**, **Run logs (JSONL)**, **CSV outputs**

## Prereqs
- Node 18+
- (Optional for Postgres tests) Docker Desktop

## Install & run
```bash
npm install
npm run dev
```
Open the URL printed (usually http://localhost:3000).

## Quick test: CSV → CSV
- Go to **Workflow**
- Source: CSV, path `./data/input.csv`
- Destination: CSV, path `result.csv`
- Click **Fetch source schema**, **Fetch destination schema**
- Click **Map by name**
- Click **Run now**
- Open `http://localhost:3000/outputs/result.csv`

## Postgres (local via Docker) → CSV
```bash
docker run --name pg-demo -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=demo -p 5432:5432 -d postgres:16
docker exec -it pg-demo psql -U postgres -d demo -c "CREATE TABLE people(id INT, name TEXT, city TEXT);
INSERT INTO people VALUES (1,'Ada','Lucknow'),(2,'Linus','Bengaluru'),(3,'Grace','Delhi');"
```
In **Workflow**:
- Source: Postgres (host: `localhost`, port: `5432`, user: `postgres`, pass: `postgres`, database: `demo`, schema: `public`, table: `people`)
- Destination: CSV `pg-dump.csv`
- Fetch schemas → Map by name → Run → open `/outputs/pg-dump.csv`

## Where logs live
- Per run under `./.runs/<runId>/run.jsonl` and `summary.json`
- Download `.jsonl` from **Logs** page