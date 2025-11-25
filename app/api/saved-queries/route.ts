import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

const SAVED_QUERIES_FILE = path.join(process.cwd(), 'data', 'saved-queries.json');

// Ensure the data directory exists
async function ensureDataDir() {
    const dataDir = path.join(process.cwd(), 'data');
    try {
        await fs.access(dataDir);
    } catch {
        await fs.mkdir(dataDir, { recursive: true });
    }
}

// Read saved queries
async function readSavedQueries() {
    try {
        await ensureDataDir();
        const content = await fs.readFile(SAVED_QUERIES_FILE, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        return [];
    }
}

// Write saved queries
async function writeSavedQueries(queries: any[]) {
    await ensureDataDir();
    await fs.writeFile(SAVED_QUERIES_FILE, JSON.stringify(queries, null, 2));
}

// GET handler to fetch saved queries
export async function GET() {
    try {
        const queries = await readSavedQueries();
        return NextResponse.json(queries);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// POST handler to save a new query
export async function POST(request: Request) {
    try {
        const newQuery = await request.json();
        const queries = await readSavedQueries();
        
        // Add timestamp and ID if not present
        const queryToSave = {
            ...newQuery,
            id: newQuery.id || Date.now().toString(),
            createdAt: newQuery.createdAt || new Date().toISOString()
        };

        // Add to beginning, maintain max 50 queries
        const updatedQueries = [queryToSave, ...queries].slice(0, 50);
        await writeSavedQueries(updatedQueries);

        return NextResponse.json(queryToSave);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// DELETE handler to remove a saved query
export async function DELETE(request: Request) {
    try {
        const { id } = await request.json();
        const queries = await readSavedQueries();
        const updatedQueries = queries.filter((q: any) => q.id !== id);
        await writeSavedQueries(updatedQueries);
        
        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}