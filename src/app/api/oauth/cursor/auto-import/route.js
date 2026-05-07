import { NextResponse } from "next/server";
import { access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ACCESS_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuth/token"];
const MACHINE_ID_KEYS = [
  "storage.serviceMachineId",
  "storage.machineId",
  "telemetry.machineId",
];

/** Get candidate db paths by platform */
function getCandidatePaths(platform) {
  const home = homedir();

  if (platform === "darwin") {
    return [
      join(
        home,
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
      ),
      join(
        home,
        "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb",
      ),
    ];
  }

  if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData =
      process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        appData,
        "Cursor - Insiders",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
      join(localAppData, "Cursor", "User", "globalStorage", "state.vscdb"),
      join(
        localAppData,
        "Programs",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ];
  }

  if (platform === "linux") {
    return [join(home, ".config/Cursor/User/globalStorage/state.vscdb")];
  }

  return [];
}

const normalize = (value) => {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * Extract tokens via better-sqlite3 (bundled dependency).
 * This is the preferred strategy — no external CLI required.
 */
async function extractTokensViaBetterSqlite(dbPath) {
  const sqliteModule = await import("better-sqlite3");
  const Database = sqliteModule.default || sqliteModule;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const placeholders = [...ACCESS_TOKEN_KEYS, ...MACHINE_ID_KEYS].map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT key, value FROM itemTable WHERE key IN (${placeholders})`,
    ).all(...ACCESS_TOKEN_KEYS, ...MACHINE_ID_KEYS);

    let accessToken = findValueForKeys(rows, ACCESS_TOKEN_KEYS);
    let machineId = findValueForKeys(rows, MACHINE_ID_KEYS);

    if ((!accessToken || !machineId) && process.platform === "darwin") {
      const fuzzyRows = db.prepare(
        "SELECT key, value FROM itemTable WHERE lower(key) LIKE '%access%token%' OR lower(key) LIKE '%machine%id%'",
      ).all();
      accessToken ||= findFuzzyValue(fuzzyRows, ["access", "token"]);
      machineId ||= findFuzzyValue(fuzzyRows, ["machine", "id"]);
    }

    return { accessToken, machineId };
  } finally {
    db.close();
  }
}

function findValueForKeys(rows, keys) {
  const row = rows.find((item) => keys.includes(item.key));
  return row ? normalize(row.value) : null;
}

function findFuzzyValue(rows, needles) {
  const row = rows.find((item) => {
    const key = String(item.key || "").toLowerCase();
    return needles.every((needle) => key.includes(needle));
  });
  return row ? normalize(row.value) : null;
}

/**
 * Extract tokens via sqlite3 CLI.
 * Fallback when better-sqlite3 native bindings are unavailable.
 */
async function extractTokensViaCLI(dbPath) {
  const normalize = (raw) => {
    const value = raw.trim();
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : value;
    } catch {
      return value;
    }
  };

  const query = async (sql) => {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
      timeout: 10000,
    });
    return stdout.trim();
  };

  // Try each key in priority order
  let accessToken = null;
  for (const key of ACCESS_TOKEN_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      if (raw) {
        accessToken = normalize(raw);
        break;
      }
    } catch {
      /* try next */
    }
  }

  let machineId = null;
  for (const key of MACHINE_ID_KEYS) {
    try {
      const raw = await query(
        `SELECT value FROM itemTable WHERE key='${key}' LIMIT 1`,
      );
      if (raw) {
        machineId = normalize(raw);
        break;
      }
    } catch {
      /* try next */
    }
  }

  return { accessToken, machineId };
}

/**
 * GET /api/oauth/cursor/auto-import
 * Auto-detect and extract Cursor tokens from local SQLite database.
 * Strategy: better-sqlite3 → sqlite3 CLI → manual fallback
 */
export async function GET() {
  try {
    const platform = process.platform;
    const candidates = getCandidatePaths(platform);

    if (candidates.length === 0) {
      return NextResponse.json(
        { found: false, error: "Unsupported platform" },
        { status: 400 },
      );
    }

    let dbPath = null;
    if (platform === "linux") {
      dbPath = candidates[0];
    } else {
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.R_OK);
          dbPath = candidate;
          break;
        } catch {
          // Try next candidate
        }
      }
    }

    if (!dbPath) {
      const macHint = platform === "darwin"
        ? "Cursor database not found in known macOS locations.\n"
        : "";
      return NextResponse.json({
        found: false,
        error: `${macHint}Cursor database not found. Checked locations:\n${candidates.join("\n")}\n\nMake sure Cursor IDE is installed and opened at least once.`,
      });
    }

    // Strategy 1: better-sqlite3 (bundled — no external tools required)
    let betterSqliteOpenError = null;
    try {
      const tokens = await extractTokensViaBetterSqlite(dbPath);
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch (error) {
      betterSqliteOpenError = error;
      if (/SQLITE_CANTOPEN|cannot open|no such file/i.test(error.message || "")) {
        const message = platform === "linux"
          ? "Cursor database not found. Make sure Cursor IDE is installed and you are logged in."
          : `Cursor database was found but could not open it: ${error.message}`;
        return NextResponse.json({ found: false, error: message });
      }
      // Native bindings unavailable — try CLI fallback
    }

    // Strategy 2: sqlite3 CLI
    try {
      const tokens = await extractTokensViaCLI(dbPath);
      if (tokens.accessToken && tokens.machineId) {
        return NextResponse.json({
          found: true,
          accessToken: tokens.accessToken,
          machineId: tokens.machineId,
        });
      }
    } catch {
      // sqlite3 CLI not available either
    }

    // Strategy 3: ask user to paste manually
    if (platform === "darwin") {
      return NextResponse.json({
        found: false,
        error: "Please login to Cursor IDE first, then reopen Cursor before retrying auto-import.",
      });
    }

    return NextResponse.json({
      found: false,
      windowsManual: true,
      dbPath,
      error: betterSqliteOpenError?.message,
    });
  } catch (error) {
    console.log("Cursor auto-import error:", error);
    return NextResponse.json(
      { found: false, error: error.message },
      { status: 500 },
    );
  }
}
