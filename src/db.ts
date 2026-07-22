import * as SQLite from 'expo-sqlite';

export type Meeting = {
  id: number;
  title: string;
  createdAt: number;
  durationSec: number;
  transcript: string;
  summary: string;
  audioUrl: string | null;
  transcriptUrl: string | null;
  folderUrl: string | null;
  /** Local file, kept until the Drive upload succeeds so a retry is possible. */
  audioPath: string | null;
  lastError: string | null;
  /** TaskNote's `id` once the meeting has been posted there; null until then. */
  taskNoteId: string | null;
};

export type NewMeeting = Omit<Meeting, 'id'>;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('voicetotext.db');
      await migrate(db);
      return db;
    })();
  }
  return dbPromise;
}

/**
 * Versioned migrations rather than a drop-and-recreate: v1 users already have
 * meetings on their device, and those transcripts only exist locally if a Drive
 * upload happened to fail.
 */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;

  if (version < 1) {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        durationSec INTEGER NOT NULL DEFAULT 0,
        transcript TEXT NOT NULL DEFAULT '',
        audioUrl TEXT,
        transcriptUrl TEXT
      );
      PRAGMA user_version = 1;
    `);
  }

  if (version < 2) {
    await db.execAsync(`
      ALTER TABLE meetings ADD COLUMN summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE meetings ADD COLUMN folderUrl TEXT;
      PRAGMA user_version = 2;
    `);
  }

  if (version < 3) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT PRIMARY KEY,
        tokens INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 3;
    `);
  }

  if (version < 4) {
    await db.execAsync(`
      ALTER TABLE meetings ADD COLUMN audioPath TEXT;
      ALTER TABLE meetings ADD COLUMN lastError TEXT;
      PRAGMA user_version = 4;
    `);
  }

  if (version < 5) {
    await db.execAsync(`
      ALTER TABLE meetings ADD COLUMN taskNoteId TEXT;
      PRAGMA user_version = 5;
    `);
  }

  if (version < 6) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS model_state (
        keyHash TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        day TEXT,
        PRIMARY KEY (keyHash, model)
      );
      PRAGMA user_version = 6;
    `);
  }
}

export type ModelStatus = 'ok' | 'quota' | 'unavailable' | 'rejected';

export type ModelStateRow = {
  keyHash: string;
  model: string;
  status: ModelStatus;
  /** Pacific day the status was recorded, or null when it does not expire. */
  day: string | null;
};

/**
 * What each key/model pair did last time. Held on disk rather than in memory
 * because the walk is expensive: every model tried re-uploads the whole
 * recording, so a restart that forgets which models are spent can cost a dozen
 * uploads of the same audio before anything succeeds.
 */
export async function loadModelState(): Promise<ModelStateRow[]> {
  const db = await getDb();
  return db.getAllAsync<ModelStateRow>('SELECT keyHash, model, status, day FROM model_state');
}

export async function saveModelState(row: ModelStateRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO model_state (keyHash, model, status, day) VALUES (?, ?, ?, ?)
     ON CONFLICT(keyHash, model) DO UPDATE SET status = excluded.status, day = excluded.day`,
    row.keyHash,
    row.model,
    row.status,
    row.day
  );
}

/** Patch a subset of columns; used as each pipeline stage completes. */
export async function updateMeeting(
  id: number,
  fields: Partial<Omit<Meeting, 'id'>>
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const db = await getDb();
  const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
  await db.runAsync(
    `UPDATE meetings SET ${assignments} WHERE id = ?`,
    ...entries.map(([, value]) => value as string | number | null),
    id
  );
}

export async function getMeeting(id: number): Promise<Meeting | null> {
  const db = await getDb();
  return db.getFirstAsync<Meeting>('SELECT * FROM meetings WHERE id = ?', id);
}

export type DailyUsage = { day: string; tokens: number; requests: number };

/** Local date, not UTC — a "daily total" should roll over at the user's midnight. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${date}`;
}

export async function recordUsage(tokens: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO usage (day, tokens, requests) VALUES (?, ?, 1)
     ON CONFLICT(day) DO UPDATE SET tokens = tokens + ?, requests = requests + 1`,
    today(),
    tokens,
    tokens
  );
}

export async function getTodayUsage(): Promise<DailyUsage> {
  const db = await getDb();
  const row = await db.getFirstAsync<DailyUsage>('SELECT * FROM usage WHERE day = ?', today());
  return row ?? { day: today(), tokens: 0, requests: 0 };
}

export async function insertMeeting(meeting: NewMeeting): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `INSERT INTO meetings
       (title, createdAt, durationSec, transcript, summary,
        audioUrl, transcriptUrl, folderUrl, audioPath, lastError, taskNoteId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    meeting.title,
    meeting.createdAt,
    meeting.durationSec,
    meeting.transcript,
    meeting.summary,
    meeting.audioUrl,
    meeting.transcriptUrl,
    meeting.folderUrl,
    meeting.audioPath,
    meeting.lastError,
    meeting.taskNoteId
  );
  return result.lastInsertRowId;
}

export async function listMeetings(): Promise<Meeting[]> {
  const db = await getDb();
  return db.getAllAsync<Meeting>('SELECT * FROM meetings ORDER BY createdAt DESC');
}

/** Used when a summary is generated after the fact, e.g. a retry from History. */
export async function updateSummary(id: number, summary: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE meetings SET summary = ? WHERE id = ?', summary, id);
}

export async function deleteMeeting(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM meetings WHERE id = ?', id);
}
