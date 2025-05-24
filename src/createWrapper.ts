// Type definitions for WebSQL-like API
type SQLStatementCallback = (tx: SQLTransaction, resultSet: SQLResultSet) => void;
type SQLStatementErrorCallback = (tx: SQLTransaction, error: SQLError) => boolean | void;
type SQLTransactionCallback = (tx: SQLTransaction) => void;
type SQLTransactionErrorCallback = (error: SQLError) => void;
type SQLTransactionSuccessCallback = () => void;
type DatabaseCallback = (db: Database) => void;

interface SQLResultSetRowList {
  length: number;
  item(index: number): any;
  /** Underlying array of result rows (each row is an object of column values) */
  _array: any[];
}

interface SQLResultSet {
  insertId?: number;
  rowsAffected: number;
  rows: SQLResultSetRowList;
}

class SQLError extends Error {
  code: number;
  static UNKNOWN_ERR = 0;
  static DATABASE_ERR = 1;
  static VERSION_ERR = 2;
  static TOO_LARGE_ERR = 3;
  static QUOTA_ERR = 4;
  static SYNTAX_ERR = 5;
  static CONSTRAINT_ERR = 6;
  static TIMEOUT_ERR = 7;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    // Maintains proper stack trace (only available in V8 environments)
    if ((<any>Error).captureStackTrace) {
      (<any>Error).captureStackTrace(this, SQLError);
    }
  }
}

interface SQLTransaction {
  executeSql(
    sqlStatement: string,
    args?: (string | number | null)[],
    callback?: SQLStatementCallback,
    errorCallback?: SQLStatementErrorCallback
  ): void;
}

interface Database {
  version: string;
  transaction(
    callback: SQLTransactionCallback,
    errorCallback?: SQLTransactionErrorCallback,
    successCallback?: SQLTransactionSuccessCallback
  ): void;
  readTransaction(
    callback: SQLTransactionCallback,
    errorCallback?: SQLTransactionErrorCallback,
    successCallback?: SQLTransactionSuccessCallback
  ): void;
  /* The legacy API included closeAsync/deleteAsync; expose them for completeness. */
  closeAsync?(): Promise<void>;
  deleteAsync?(): Promise<void>;
}

// Wrapper implementation
// Sort of conforms to https://www.w3.org/TR/webdatabase good enough that at least it matches the original expo-sqlite/legacy
function createWebSQLWrapper(SQLite: any): { openDatabase: (...args: any[]) => Database } {
  // Helper to convert various errors to SQLError with appropriate code
  const toSQLError = (err: any): SQLError => {
    if (err instanceof SQLError) {
      return err;
    }
    let message = err && err.message ? err.message : String(err);
    let code = SQLError.UNKNOWN_ERR;
    // Heuristic mappings for common error messages to WebSQL error codes
    if (/constraint failed/i.test(message) || /foreign key constraint/i.test(message)) {
      code = SQLError.CONSTRAINT_ERR;
    } else if (/syntax error/i.test(message) || /no such table/i.test(message) || /could not prepare/i.test(message)) {
      code = SQLError.SYNTAX_ERR;
    } else if (/too (large|big)/i.test(message) || /string or blob too big/i.test(message)) {
      code = SQLError.QUOTA_ERR;
    } else if (/locked/i.test(message) || /database is locked/i.test(message) || /timeout/i.test(message)) {
      code = SQLError.TIMEOUT_ERR;
    }
    return new SQLError(code, message);
  };

  class WebSQLTransaction implements SQLTransaction {
    private _statements: {
      sql: string;
      args: (string | number | null)[] | undefined;
      successCallback?: SQLStatementCallback;
      errorCallback?: SQLStatementErrorCallback;
    }[] = [];
    private _finished: boolean = false;
    constructor(private _dbWrapper: WebSQLDatabase, private _readOnly: boolean) { }
    executeSql(
      sqlStatement: string,
      args: (string | number | null)[] = [],
      callback?: SQLStatementCallback,
      errorCallback?: SQLStatementErrorCallback
    ): void {
      if (this._finished) {
        // No new statements allowed after the initial transaction callback
        return;
      }
      // Basic read-only enforcement: prevent writes in readTransaction
      if (this._readOnly) {
        const sqlUpper = sqlStatement.trim().toUpperCase();
        if (
          sqlUpper.startsWith("INSERT") || sqlUpper.startsWith("UPDATE") ||
          sqlUpper.startsWith("DELETE") || sqlUpper.startsWith("REPLACE") ||
          sqlUpper.startsWith("CREATE") || sqlUpper.startsWith("DROP") ||
          sqlUpper.startsWith("ALTER") || sqlUpper.startsWith("PRAGMA ") && sqlUpper.includes("=")
        ) {
          // Attempted a modifying query in readTransaction – abort the transaction
          throw new SQLError(SQLError.DATABASE_ERR, "Invalid modification in readTransaction");
        }
      }
      this._statements.push({
        sql: sqlStatement,
        args,
        successCallback: callback,
        errorCallback: errorCallback
      });
    }
    /** Mark the transaction as finished (no more queries can be added) */
    _markFinished() {
      this._finished = true;
    }
    /** Internal helper to get all queued statements */
    _getStatements() {
      return this._statements;
    }
  }

  class WebSQLDatabase implements Database {
    version: string;
    /** The underlying Expo SQLiteDatabase instance 
     * To check types, change to ExpoSQLite.SQLiteDatabase
    */
    private _db: any;
    constructor(db: any) {
      this._db = db;
      this.version = "";  // Expo's WebSQL legacy ignored the version
      // Expose closeAsync and deleteAsync if available in new API
      if (typeof db.closeAsync === "function") {
        (this as Database).closeAsync = () => db.closeAsync();
      }
      if (typeof db.deleteAsync === "function") {
        (this as Database).deleteAsync = () => db.deleteAsync();
      }
    }

    transaction(callback: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback, successCallback?: SQLTransactionSuccessCallback): void {
      this._executeTransaction(callback, errorCallback, successCallback, /*readOnly*/ false);
    }

    readTransaction(callback: SQLTransactionCallback, errorCallback?: SQLTransactionErrorCallback, successCallback?: SQLTransactionSuccessCallback): void {
      this._executeTransaction(callback, errorCallback, successCallback, /*readOnly*/ true);
    }

    private _executeTransaction(
      callback: SQLTransactionCallback,
      errorCallback?: SQLTransactionErrorCallback,
      successCallback?: SQLTransactionSuccessCallback,
      readOnly: boolean = false
    ): void {
      const tx = new WebSQLTransaction(this, readOnly);
      let succeeded = false;
      let userError: any;
      try {
        // Invoke the transaction callback synchronously to queue SQL statements
        callback(tx);
        succeeded = true;
      } catch (err) {
        // Capture any error thrown during the callback (immediate failure)
        userError = err;
      }
      // Mark transaction finished so no new executeSql can be called after this
      tx._markFinished();
      // Function to run the queued SQL statements asynchronously
      const runStatementsAsync = async () => {
        if (!succeeded) {
          // If user callback threw an error, abort without executing any statements
          throw userError;
        }
        const statements = tx._getStatements();
        if (statements.length === 0) {
          // No queries: commit a no-op transaction
          return;
        }
        // Use the new Expo SQLite API's transaction mechanism to ensure atomicity
        await this._db.withTransactionAsync(async () => {
          for (const stmt of statements) {
            const { sql, args, successCallback: scb, errorCallback: ecb } = stmt;
            try {
              // Decide whether to fetch results (SELECT/PRAGMA) or just run (INSERT/UPDATE/etc.)
              let resultSet: SQLResultSet;
              const sqlUpper = sql.trim().toUpperCase();
              if (
                sqlUpper.startsWith("SELECT") || sqlUpper.startsWith("PRAGMA") ||
                sqlUpper.startsWith("EXPLAIN") || sqlUpper.startsWith("WITH")
              ) {
                // For queries that return rows, use getAllAsync to fetch results
                const queryResult = args && args.length > 0
                  ? await this._db.getAllAsync(sql, ...(args as []))
                  : await this._db.getAllAsync(sql);
                const rowsArray: any[] = Array.isArray(queryResult) ? queryResult : [];
                resultSet = {
                  rows: {
                    _array: rowsArray,
                    length: rowsArray.length,
                    item(index: number) { return rowsArray[index] ?? null; }
                  },
                  rowsAffected: 0,
                  insertId: undefined
                };
              } else {
                // For statements that modify data (no result rows)
                const execResult = args && args.length > 0
                  ? await this._db.runAsync(sql, ...(args as []))
                  : await this._db.runAsync(sql);
                const changes: number = execResult.changes ?? 0;
                const lastInsertId = execResult.lastInsertRowId;
                resultSet = {
                  rows: {
                    _array: [],
                    length: 0,
                    item(index: number) { return null; }
                  },
                  rowsAffected: changes,
                  insertId: (lastInsertId !== null && lastInsertId !== undefined) ? lastInsertId : undefined
                };
              }
              // Invoke the per-statement success callback if provided
              if (scb) {
                try {
                  scb(tx, resultSet);
                } catch (cbErr) {
                  // If a success callback throws, treat it as a transaction failure
                  throw cbErr;
                }
              }
            } catch (err) {
              // Handle statement error
              const errorObj = toSQLError(err);
              let shouldRollback = true;
              if (ecb) {
                try {
                  // If the statement error callback returns false, skip rollback and continue
                  const handled = ecb(tx, errorObj);
                  if (handled === false) {
                    shouldRollback = false;
                  }
                } catch (cbErr) {
                  // Error in errorCallback, consider transaction failed
                  shouldRollback = true;
                }
              }
              if (shouldRollback) {
                // Throw to break out of withTransactionAsync, causing an automatic rollback
                throw errorObj;
              } else {
                // If handled (no rollback), just continue to next statement (skip calling its success callback)
                continue;
              }
            }
          }
        });
      };

      // Schedule the execution of the transaction asynchronously (async task)
      (async () => {
        try {
          await runStatementsAsync();
          // If all statements succeed, invoke the transaction success callback
          if (successCallback) {
            successCallback();
          }
        } catch (err) {
          // If an error caused a rollback, invoke the transaction error callback with the error
          const finalError = toSQLError(err);
          if (errorCallback) {
            errorCallback(finalError);
          }
        }
      })();
    }
  }

  return {
    openDatabase: (
      name: string,
      version?: string,
      description?: string,
      size?: number,
      creationCallback?: DatabaseCallback
    ): Database => {
      // The `version`, `description`, and `size` parameters are not used (for compatibility with spec only)
      // https://docs.expo.dev/versions/v51.0.0/sdk/sqlite-legacy/# (Read on 2025.05.24)
      let db: any;
      if (typeof SQLite.openDatabaseSync === "function") {
        // Use synchronous open if available (JSI/Hermes) for immediate return
        db = SQLite.openDatabaseSync(name);
      } else if (typeof SQLite.openDatabase === "function") {
        // Fallback to old openDatabase if still exposed
        db = SQLite.openDatabase(name);
      } else {
        throw new Error("Expo SQLite: no synchronous openDatabase method available.");
      }
      const wrappedDB = new WebSQLDatabase(db);
      // If a creation callback is provided, call it
      if (creationCallback) {
        // Note: We cannot easily detect if the DB was newly created. We call callback asynchronously regardless.
        setTimeout(() => creationCallback(wrappedDB), 0);
      }
      return wrappedDB;
    }
  };
}

export { createWebSQLWrapper, Database, SQLTransaction, SQLResultSet, SQLError };
