// Wrapper implementation
// Sort of conforms to https://www.w3.org/TR/webdatabase good enough that at least it matches the original expo-sqlite/legacy
function createWebSQLWrapper(SQLite: any) {
  // Helper to convert various errors to SQLError with appropriate code
  interface SQLResultSet {
    insertId?: number;
    rowsAffected: number;
    rows: SQLResultSetRowList;
  }

  interface SQLResultSetRowList {
    _array: any[];              // actual array of row objects
    length: number;
    item(index: number): any;
  }

  type SuccessCallback = (tx: WebSQLTransaction, resultSet: SQLResultSet) => void;
  type ErrorCallback = (tx: WebSQLTransaction, error: Error) => boolean | void;

  class WebSQLDatabase {
    private _db: any; //SQLite.SQLiteDatabase;
    private _txnChain: Promise<void> = Promise.resolve();  // used to sequence transactions

    constructor(name: string) {
      // Open or create the SQLite database file (synchronously for immediate return)
      // Sanitize name to avoid invalid filename or path issues.
      const dbName = sanitizeDbName(name);
      this._db = SQLite.openDatabaseSync(dbName);
      // (On web, openDatabaseSync uses an in-memory/IDB-backed DB; on native it opens a file in default location.)
    }

    /** Begins a read-write transaction. */
    transaction(callback: (tx: WebSQLTransaction) => void,
      errorCallback?: (error: Error) => void,
      successCallback?: () => void): void {
      this._enqueueTransaction(callback, errorCallback, successCallback, /*readOnly=*/false);
    }

    /** Begins a read-only transaction (disallows any INSERT/UPDATE/DELETE statements). */
    readTransaction(callback: (tx: WebSQLTransaction) => void,
      errorCallback?: (error: Error) => void,
      successCallback?: () => void): void {
      this._enqueueTransaction(callback, errorCallback, successCallback, /*readOnly=*/true);
    }

    /** Internal helper to enqueue and run the transaction in sequence. */
    private _enqueueTransaction(
      callback: (tx: WebSQLTransaction) => void,
      errorCallback?: (error: Error) => void,
      successCallback?: () => void,
      readOnly: boolean = false
    ): void {
      // Chain this transaction onto the previous one to serialize them
      this._txnChain = this._txnChain.then(async () => {
        const tx = new WebSQLTransaction(this._db, readOnly);
        try {
          // Start the SQLite transaction (BEGIN)
          await tx._begin();

          // Execute user callback to allow queuing queries
          try {
            callback(tx);
          } catch (err) {
            // Synchronous error in the transaction callback – rollback and throw to error handler
            await tx._rollback();
            // Propagate to transaction-level error handler (or throw if none)
            throw err;
          }

          // All queries queued; now run them in sequence
          const outcome = await tx._executeQueuedQueries();
          if (outcome === 'commit') {
            // Commit successful
            await tx._commit();
            if (successCallback) successCallback();
          } else if (outcome === 'rollback') {
            // A query signaled rollback or failed without recovery
            await tx._rollback();
            // If an error callback was provided for the transaction, call it
            if (errorCallback) {
              errorCallback(tx._lastError!);
            }
          }
        } catch (err: any) {
          // If we catch here, it means a transaction-level failure not handled by query logic.
          // Already rolled back (in cases above) if needed. Just call the transaction errorCallback if provided.
          if (errorCallback) {
            errorCallback(err);
          }
          // (If no errorCallback, the error is swallowed to avoid unhandled promise; 
          // in WebSQL, errors in transactions with no error handler are typically ignored silently.)
        }
      }).catch(e => {
        // Catch any error to prevent unhandled promise rejections in the chain.
        // (Errors are already handled above via callbacks, so this is just a safety net.)
        console.error('Unhandled transaction error:', e);
      });
    }
  }

  class WebSQLTransaction {
    private _db: any; //SQLite.SQLiteDatabase;
    private _readOnly: boolean;
    private _statements: Array<{
      sql: string;
      args: any[];
      successCallback?: SuccessCallback;
      errorCallback?: ErrorCallback;
      forceError?: Error;    // pre-set error to throw (e.g., read-only violation)
    }> = [];
    private _inProgress: boolean = false;
    _lastError: Error | null = null;  // store last error that caused rollback (if any)

    constructor(db: any /* SQLite.SQLiteDatabase*/, readOnly: boolean) {
      this._db = db;
      this._readOnly = readOnly;
    }

    /** Enqueue a SQL statement for this transaction. */
    executeSql(sql: string,
      args: any[] = [],
      successCallback?: SuccessCallback,
      errorCallback?: ErrorCallback): void {
      // If transaction already finished, disallow adding new statements
      if (!this._inProgress && this._statements.length === 0) {
        // Not begun yet (we're in initial callback), it's fine to add.
      } else if (!this._inProgress) {
        // If not inProgress but statements exist, still fine (initial callback phase).
      } else {
        // If _inProgress is true, queries are being executed (we're in a statement callback), 
        // but we allow queuing additional queries as long as transaction not finished.
      }
      if (this._finished) {
        console.warn('Transaction already completed - cannot add new statements.');
        return;
      }

      // Enforce read-only mode: block any modifying queries
      if (this._readOnly && isWriteStatement(sql)) {
        // Instead of executing, we queue a forced error for this statement
        const error = new Error(`Invalid attempt to execute a write statement in readTransaction: "${sql}"`);
        this._statements.push({
          sql,
          args,
          successCallback,
          errorCallback,
          forceError: error
        });
        return;
      }

      // Queue the statement for later execution
      this._statements.push({
        sql,
        args,
        successCallback,
        errorCallback
      });
    }

    // The following methods are internal, called by WebSQLDatabase to manage transaction flow:

    /** Mark the beginning of the transaction (EXECUTE "BEGIN"). */
    async _begin(): Promise<void> {
      this._inProgress = true;
      try {
        // Use a deferred transaction for read-write, or immediate read-only transaction?
        // SQLite has no true read-only txn mode, so just BEGIN for both.
        await this._db.execAsync('BEGIN;');
      } catch (err) {
        this._inProgress = false;
        throw err;
      }
    }

    /** Execute all queued statements in order. Returns "commit" if success, "rollback" if should rollback. */
    async _executeQueuedQueries(): Promise<'commit' | 'rollback'> {
      let shouldRollback = false;
      for (let i = 0; i < this._statements.length; i++) {
        const { sql, args, successCallback, errorCallback, forceError } = this._statements[i];

        try {
          let result: SQLResultSet;
          if (forceError) {
            // Simulate a query failure (e.g., read-only violation)
            throw forceError;
          }
          // Determine if this is a read/query or write operation
          const isSelect = isSelectStatement(sql);
          if (isSelect) {
            // Execute query and get all rows
            const rows = await this._db.getAllAsync(sql, args);
            result = {
              rowsAffected: 0,
              insertId: undefined,
              rows: createRowList(rows)
            };
          } else {
            // Execute write (INSERT/UPDATE/DELETE or DDL)
            const res = await this._db.runAsync(sql, ...(Array.isArray(args) ? args : [args]));
            // Expo runAsync returns an object with `lastInsertRowId` and `changes`
            const lastId = res?.lastInsertRowId ?? undefined;
            const changes = res?.changes ?? 0;
            result = {
              rowsAffected: changes,
              insertId: (lastId && lastId > 0) ? lastId : undefined,
              rows: createRowList([])  // no result rows for write ops
            };
          }

          // If successful, invoke the per-statement success callback if provided
          if (successCallback) {
            try {
              successCallback(this, result);
            } catch (callbackErr) {
              // If the success callback itself throws an error, treat it as a transaction failure
              this._lastError = callbackErr instanceof Error ? callbackErr : new Error(String(callbackErr));
              return 'rollback';
            }
          }
          // Continue to next statement
        } catch (err: any) {
          // A statement error occurred (either from SQLite or a forced error)
          const error = err instanceof Error ? err : new Error(String(err));
          this._lastError = error;
          let rollbackThisTxn = true;  // default to rollback the entire transaction

          if (errorCallback) {
            // Invoke the statement-level error callback
            try {
              const userWantsRollback = errorCallback(this, error);
              // According to WebSQL spec:
              // If error callback returns false, *don't rollback* (continue transaction):contentReference[oaicite:12]{index=12}.
              if (userWantsRollback === false) {
                rollbackThisTxn = false;
              }
            } catch (callbackErr) {
              // If the error callback itself throws, we must rollback
              rollbackThisTxn = true;
            }
          }

          if (rollbackThisTxn) {
            // Stop processing further statements – initiate rollback
            return 'rollback';
          } else {
            // User elected to continue the transaction despite the error.
            // Skip to next statement (transaction remains active).
            continue;
          }
        }
      }
      // If loop completes with no unrecoverable errors, commit the transaction
      return 'commit';
    }

    /** Commit the transaction (EXECUTE "COMMIT"). */
    async _commit(): Promise<void> {
      try {
        await this._db.execAsync('COMMIT;');
      } finally {
        this._inProgress = false;
        this._finished = true;
      }
    }

    /** Roll back the transaction (EXECUTE "ROLLBACK"). */
    async _rollback(): Promise<void> {
      try {
        await this._db.execAsync('ROLLBACK;');
      } finally {
        this._inProgress = false;
        this._finished = true;
      }
    }

    // Flag to mark transaction completion. Prevents further executeSql calls.
    private _finished: boolean = false;
  }

  function sanitizeDbName(name: string): string {
    // Map an empty name to a default file name
    if (!name || name.trim().length === 0) {
      name = 'database';  // default name for unnamed databases
    }
    // Disallow path separators or other invalid filename characters
    // Replace anything except letters, numbers, underscores, and dots with underscore
    name = name.replace(/[^A-Za-z0-9._-]/g, '_');
    // On iOS, the database file is created under .../SQLite/<name>.
    // Ensure the name has a .db extension for clarity (optional, but recommended).
    if (!name.endsWith('.db')) {
      name += '.db';
    }
    return name;
  }

  function isSelectStatement(sql: string): boolean {
    const firstWord = sql.trim().split(/\s+/, 1)[0].toUpperCase();
    return (
      firstWord === 'SELECT' ||
      firstWord === 'PRAGMA' ||   // Treat PRAGMA queries as read operations (they may return data)
      firstWord === 'EXPLAIN' ||
      firstWord === 'WITH'       // Common table expressions start with WITH and yield results
    );
  }

  function isWriteStatement(sql: string): boolean {
    // If it's not a read statement, assume it's a write (includes CREATE, INSERT, UPDATE, DELETE, etc.)
    return !isSelectStatement(sql);
  }

  function createRowList(rowsArray: any[]): SQLResultSetRowList {
    return {
      _array: rowsArray,
      length: rowsArray.length,
      item(index: number) {
        if (index < 0 || index >= rowsArray.length) {
          return null;
        }
        return rowsArray[index];
      }
    };
  }

  /**
   * Opens a WebSQL-compatible database. Mimics window.openDatabase.
   * @param name Name of the database file. (Version, description, size are ignored for compatibility.)
   * @param version Unused (provide an empty string or version for compatibility).
   * @param description Unused.
   * @param size Unused.
   * @param callback Optional callback invoked with the Database object.
   * @returns WebSQLDatabase object
   */
  return {
    openDatabase(
      name: string,
      version: string = '1.0',
      description: string = '',
      size: number = 1,
      callback?: (db: WebSQLDatabase) => void
    ): WebSQLDatabase {
      const db = new WebSQLDatabase(name);
      // The version, description, and size parameters are not used (WebSQL spec compatibility):contentReference[oaicite:13]{index=13}.
      // If a creation callback is provided, call it (WebSQL spec calls this upon database creation or version upgrade).
      if (typeof callback === 'function') {
        // Invoke callback after opening, in a separate tick to mimic async behavior
        try {
          callback(db);
        } catch (err) {
          console.error('openDatabase callback error:', err);
        }
      }
      return db;
    }
  }
}

export { createWebSQLWrapper };
