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

## Get the latest query-enabled workflow locally
Follow the path that matches your setup so you can run the build that includes the new source query box.

### 1. First-time setup (no local copy yet)
Choose one of the download paths below, then follow the rest of this guide.

#### Option A: Clone with Git (recommended)
Clone the repository from the canonical remote. Replace `<repo-url>` with the HTTPS/SSH address that hosts this project (for example, a GitHub or GitLab URL).

```bash
git clone <repo-url>
cd universal-migrator-app
npm install
```

After cloning, skip to [Start the dev server](#install--run).

#### Option B: Download as a ZIP
If you are not ready to install Git, download the source archive directly:

1. Visit the repository page in your browser.
2. Click **Code ▾ → Download ZIP**.
3. Extract the archive, open a terminal inside the extracted folder, and run `npm install` followed by `npm run dev`.
4. (Optional) When you later install Git, you can turn this folder into a repository with `git init`, `git remote add origin <repo-url>`, and `git fetch` to start tracking upstream updates.

### 2. Existing clone without a remote
If `git remote -v` prints nothing, register the upstream remote once and then fetch the latest commits:

```bash
git remote add origin <repo-url>
git fetch origin
git checkout work        # or the branch you plan to use
git pull --ff-only origin work
```

### 3. Existing clone already tracking a remote
When `git remote -v` shows `origin`, simply sync:

```bash
git fetch origin
git checkout work        # or whichever branch you prefer
git pull --ff-only origin work
```

If you maintain your own feature branch, rebase or merge from `origin/work` so your branch inherits the query box changes.

> **Tip:** If you have local edits that conflict with the update, use `git stash` (before pulling) and `git stash pop` (after the pull) to reapply your work.

## Quick test: CSV → CSV
- Go to **Workflow**
- Source: CSV, path `./data/input.csv`
- Destination: CSV, path `result.csv`
- Click **Fetch source schema**, **Fetch destination schema**
- Click **Map by name**
- Click **Run now**
- Open `http://localhost:3000/outputs/result.csv`

## Try the query-enabled source locally
Follow these steps if you want to validate the new query textarea without wiring up your own database yet.

1. [Start the dev server](#install--run) in one terminal.
2. In a second terminal, launch the sample Postgres container and load data:

   ```bash
   docker run --name pg-query-demo -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=demo -p 5433:5432 -d postgres:16
   docker exec -it pg-query-demo psql -U postgres -d demo <<'SQL'
   CREATE TABLE cities(id SERIAL PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL);
   INSERT INTO cities(name, country) VALUES
     ('Lucknow', 'India'),
     ('Bengaluru', 'India'),
     ('San Francisco', 'USA');
   SQL
   ```

3. In the **Workflow** canvas, configure the source node:
   - **Type:** Postgres
   - **Host:** `localhost`
   - **Port:** `5433`
   - **User / Password:** `postgres`
   - **Database:** `demo`
   - **Source mode:** `Query`
   - Leave **Table** empty
   - Paste this into **Query**:

     ```sql
     SELECT name, country FROM cities WHERE country = 'India';
     ```

4. Add a CSV destination with output path `cities-in-india.csv`.
5. Click **Run now**.
6. Download the result from `http://localhost:3000/outputs/cities-in-india.csv` and confirm it only lists the filtered rows.

When you are done experimenting, stop and remove the demo container:

```bash
docker rm -f pg-query-demo
```

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