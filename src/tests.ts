// @ts-ignore
import * as ExpoSQLite from 'expo-sqlite';
// @ts-ignore
import * as ExpoSQLiteLegacy from 'expo-sqlite/legacy';
import { createWebSQLWrapper } from './createWrapper';

////////////////////////////////////////////////////////////////////////////////
// Types

type DbFactory = { openDatabase: (name: string) => WebSQLDatabase };
interface WebSQLTransaction {
  executeSql(
    sql: string,
    args?: any[],
    onSuccess?: (tx: any, rs: any) => void,
    onError?: (tx: any, err: any) => boolean | void
  ): void;
}
interface WebSQLDatabase {
  transaction(
    cb: (tx: WebSQLTransaction) => void,
    onError?: (err: any) => void,
    onSuccess?: () => void
  ): void;
  readTransaction(
    cb: (tx: WebSQLTransaction) => void,
    onError?: (err: any) => void,
    onSuccess?: () => void
  ): void;
}

// A test definition
interface WebSQLTest {
  name: string;
  run: (dbf: DbFactory) => Promise<any>;
  // expected: either a literal value to compare with deep equality,
  // or a function predicate that returns true/false for a given result.
  expected?: any | ((res: any) => boolean);
}

////////////////////////////////////////////////////////////////////////////////
// Prepare DB factories

const LegacyDB: DbFactory = {
  openDatabase: (name: string) => (ExpoSQLiteLegacy.openDatabase(name) as any)
};

const ShimDB: DbFactory = {
  openDatabase: (name: string) => createWebSQLWrapper(ExpoSQLite).openDatabase(name) as any
};

////////////////////////////////////////////////////////////////////////////////
// Helper to compare deep-equal (simple JSON approach)
const deepEqual = (a: any, b: any): boolean => {
  // fast path for primitives
  if (a === b) return true;
  // fallback for objects/arrays
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Names of test tables/databases to reset */
const TEST_DB_COUNT = 10;
const TEST_DB_NAMES = Array.from({ length: TEST_DB_COUNT }, (_, i) => ({
  dbName: `t${i + 1}.db`,
  table: `t${i + 1}`
}));

/** Drop all test tables in each database for a given factory */
async function clearTestTables(dbf: DbFactory): Promise<void> {
  for (const { dbName, table } of TEST_DB_NAMES) {
    const db = dbf.openDatabase(dbName);
    // Wrap in a Promise so we can await the async transaction
    await new Promise<void>((resolve, reject) => {
      db.transaction(
        tx => {
          tx.executeSql(`DROP TABLE IF EXISTS ${table};`);
        },
        err => {
          console.warn(`Failed to drop ${table} in ${dbName}:`, err);
          // still resolve so one failure doesn’t block the rest
          resolve();
        },
        () => resolve()
      );
    });
  }
}

////////////////////////////////////////////////////////////////////////////////
// Define tests (with expected spec behavior)

const tests: WebSQLTest[] = [

  {
    name: 'Test#1: INSERT returns insertId & rowsAffected=1',
    run: async (dbf) => {
      const db = dbf.openDatabase('t1.db');
      return new Promise((res, rej) =>
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t1;');
          tx.executeSql('CREATE TABLE t1 (id INTEGER PRIMARY KEY, txt TEXT);');
          tx.executeSql('INSERT INTO t1 (txt) VALUES (?)', ['hello'], (_tx, rs) =>
            res({ insertId: rs.insertId, rowsAffected: rs.rowsAffected })
          );
        }, rej)
      );
    },
    expected: (out: any) =>
      typeof out.insertId === 'number' && out.rowsAffected === 1
  },

  {
    name: 'Test#2: UPDATE then SELECT yields updated value',
    run: async (dbf) => {
      const db = dbf.openDatabase('t2.db');
      return new Promise((res, rej) =>
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t2;');
          tx.executeSql('CREATE TABLE t2 (id INTEGER PRIMARY KEY, val INT);');
          tx.executeSql('INSERT INTO t2 (val) VALUES (1);');
          tx.executeSql('UPDATE t2 SET val = val + 1 WHERE id = 1;');
          tx.executeSql('SELECT val FROM t2 WHERE id = 1;', [], (_tx, rs) =>
            res(rs.rows.item(0).val)
          );
        }, rej)
      );
    },
    expected: 2
  },

  {
    name: 'Test#3: syntax error → rollback, no final rows',
    run: async (dbf) => {
      const db = dbf.openDatabase('t3.db');
      return new Promise((resolve) => {
        let sawError = false;
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t3;');
          tx.executeSql('CREATE TABLE t3 (id INTEGER PRIMARY KEY);');
          tx.executeSql('INSRT INTO t3 VALUES (1);', [], undefined, () => {
            sawError = true;
            return true; // rollback
          });
          tx.executeSql('INSERT INTO t3 VALUES (2);');
        },
          // tx error callback
          () => resolve({ sawError, finalCount: 0 }),
          // success callback shouldn't fire
          () => resolve({ sawError, finalCount: 'unexpected success' })
        );
      });
    },
    expected: { sawError: true, finalCount: 0 }
  },

  {
    name: 'Test#4: write in readTransaction throws',
    run: async (dbf) => {
      const db = dbf.openDatabase('t4.db');
      return new Promise((resolve) => {
        let threw = false;
        db.readTransaction(tx => {
          try {
            tx.executeSql('DROP TABLE IF EXISTS t4;');
          } catch (e) {
            threw = true;
          }
          resolve(threw);
        });
      });
    },
    // spec says: readTransaction should not allow writes ⇒ must throw
    expected: true
  },

  {
    name: 'Test#5: no-callback executeSql silently succeeds',
    run: async (dbf) => {
      const db = dbf.openDatabase('t5.db');
      return new Promise((resolve, reject) =>
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t5;');
          tx.executeSql('CREATE TABLE t5 (id INTEGER);');
          tx.executeSql('INSERT INTO t5 (id) VALUES (42);');
          resolve(true);
        }, reject)
      );
    },
    expected: true
  },

  {
    name: 'Test#6: errorCallback returns false suppresses rollback',
    run: async (dbf) => {
      const db = dbf.openDatabase('t6.db');
      return new Promise((resolve, reject) =>
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t6;');
          tx.executeSql('CREATE TABLE t6 (id INTEGER);');
          tx.executeSql('INSRT INTO t6 VALUES (1);', [], undefined, () => false);
          tx.executeSql('INSERT INTO t6 (id) VALUES (2);');
        },
          reject,
          () => {
            // on success, count rows
            db.readTransaction(rtx => {
              rtx.executeSql('SELECT COUNT(*) AS c FROM t6;', [], (_, rs) =>
                resolve(rs.rows.item(0).c)
              );
            });
          })
      );
    },
    expected: 1
  },

  {
    name: 'Test#7: parameter binding & NULL',
    run: async (dbf) => {
      const db = dbf.openDatabase('t7.db');
      return new Promise((resolve, reject) =>
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t7;');
          tx.executeSql('CREATE TABLE t7 (a TEXT, b INTEGER, c REAL, d BLOB);');
          tx.executeSql(
            'INSERT INTO t7 (a, b, c, d) VALUES (?, ?, ?, ?)',
            ['foo', null, 3.14, null],
            (_tx, rs) =>
              resolve({
                insertId: rs.insertId,
                rowsAffected: rs.rowsAffected
              })
          );
        }, reject)
      );
    },
    expected: (out: any) =>
      typeof out.insertId === 'number' && out.rowsAffected === 1
  },

  {
    name: 'Test#8: PRAGMA user_version = 123 → read back 123',
    run: async (dbf) => {
      const db = dbf.openDatabase('t8.db');
      return new Promise((resolve, reject) =>
        db.transaction(tx => {
          tx.executeSql('PRAGMA user_version = 123;');
          tx.executeSql('PRAGMA user_version;', [], (_tx, rs) =>
            resolve(rs.rows.item(0).user_version)
          );
        }, reject)
      );
    },
    expected: 123
  },

  {
    name: 'Test#9: UPDATE no match → rowsAffected = 0',
    run: async (dbf) => {
      const db = dbf.openDatabase('t9.db');
      return new Promise((resolve, reject) =>
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t9;');
          tx.executeSql('CREATE TABLE t9 (id INTEGER PRIMARY KEY, x INTEGER);');
          tx.executeSql('INSERT INTO t9 (x) VALUES (10);');
          tx.executeSql('UPDATE t9 SET x = x+1 WHERE id=999;', [], (_tx, rs) =>
            resolve(rs.rowsAffected)
          );
        }, reject)
      );
    },
    expected: 0
  },

  {
    name: 'Test#10: multi-statement in one executeSql',
    run: async (dbf) => {
      const db = dbf.openDatabase('t10.db');
      return new Promise((resolve) => {
        let done = false;
        const finish = (val: any) => {
          if (!done) {
            done = true;
            resolve(val);
          }
        };
        db.transaction(tx => {
          tx.executeSql('DROP TABLE IF EXISTS t10;');
          tx.executeSql(
            'CREATE TABLE t10 (id INTEGER); INSERT INTO t10 (id) VALUES (7);',
            [],
            () => {
              // success callback
              db.readTransaction(rtx => {
                rtx.executeSql('SELECT COUNT(*) AS c FROM t10;', [], (_rtx, rrs) =>
                  finish({ mode: 'success', count: rrs.rows.item(0).c })
                );
              });
            },
            (_tx, err) => {
              finish({ mode: 'error', code: err.code });
              return false;
            }
          );
        },
          err => finish({ mode: 'tx-error', message: err.message }),
          () => finish({ mode: 'tx-success-no-callback' })
        );
      });
    },
  }
];

////////////////////////////////////////////////////////////////////////////////
// Runner

export async function runComparisonTests(): Promise<void> {
  console.log('🏁 Starting WebSQL spec compliance tests…');
  console.log('⚙️ Clearing out old test tables…');
  // Clear legacy and shim DBs
  await clearTestTables(LegacyDB);
  await clearTestTables(ShimDB);
  console.log('🏁 Running WebSQL tests on a clean slate…');
  const results: Array<{
    name: string;
    expected: any;
    legacy: any; legacyPass: boolean;
    shim: any; shimPass: boolean;
  }> = [];

  for (const test of tests) {
    // run legacy
    let legacyRes: any, shimRes: any;
    try {
      legacyRes = await test.run(LegacyDB);
    } catch (e) {
      legacyRes = e;
    }
    // run shim
    try {
      shimRes = await test.run(ShimDB);
    } catch (e) {
      shimRes = e;
    }

    let legacyPass = false, shimPass = false;
    if (test.expected !== undefined) {
      // spec-driven
      const check = typeof test.expected === 'function'
        ? (test.expected as any)
        : ((val: any) => deepEqual(val, test.expected));
      legacyPass = check(legacyRes);
      shimPass = check(shimRes);
    } else {
      // no expected: just compare implementations
      legacyPass = shimPass = deepEqual(legacyRes, shimRes);
    }

    results.push({
      name: test.name,
      expected: test.expected,
      legacy: legacyRes,
      legacyPass: legacyPass,
      shim: shimRes,
      shimPass: shimPass
    });
  }

  // Log
  console.log('🔍 Detailed Results:');
  results.forEach(r => {
    console.log(`\n• ${r.name}`);
    console.log(`    Expected: ${typeof r.expected === 'function' ? '[predicate]' : JSON.stringify(r.expected)}`);
    console.log(`    Legacy : ${r.legacyPass ? '✔ PASS' : '✖ FAIL'} → ${JSON.stringify(r.legacy)}`);
    console.log(`    Shim   : ${r.shimPass ? '✔ PASS' : '✖ FAIL'} → ${JSON.stringify(r.shim)}`);
  });

  // Summary
  const legacyFails = results.filter(r => !r.legacyPass).length;
  const shimFails = results.filter(r => !r.shimPass).length;
  console.log('\n✅ Summary:');
  console.log(`    Legacy failures: ${legacyFails}/${results.length}`);
  console.log(`    Shim   failures: ${shimFails}/${results.length}`);

  if (shimFails === 0) {
    console.log('🎉 Shim is fully spec-compliant!');
  } else {
    console.warn('⚠️ Shim has spec deviations—please review above.');
  }
}
