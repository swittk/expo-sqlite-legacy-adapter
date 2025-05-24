# Expo SQLite Legacy Adapter

This library provides a wrapper around the newer React Native Expo SDK 51+ `expo-sqlite`, enabling it to behave like the older `expo-sqlite/legacy` module that was removed starting from SDK 52.

## Installation

```bash
npm install expo-sqlite-legacy-adapter
```

## Usage

```ts
import { createWebSQLWrapper } from 'expo-sqlite-legacy-adapter';
import * as ExpoSQLite from 'expo-sqlite';

const WebSQLWrapper = createWebSQLWrapper(ExpoSQLite);
const openDatabase = WebSQLWrapper.openDatabase;

// In your project, you can now use openDatabase as if nothing ever happened!
export default openDatabase;


// e.g. just do this
const db = openDatabase('my-database.db');

// Use the database as you would with the legacy API
db.transaction(tx => {
    tx.executeSql('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY NOT NULL, name TEXT);');
});
```

## Why Make This?

The rationale behind creating this library stems from the need to support legacy libraries that rely on WebSQL, which is no longer natively available on Expo/React-Native starting from Expo SDK 52. For instance, my previous patches to projects like [IndexedDBShim](https://github.com/indexeddbshim/IndexedDBShim/issues/313#issuecomment-590086778) to enable IndexedDB functionality on React Native would not work without WebSQL support. This adapter bridges that gap, ensuring compatibility and extending the usability of such libraries.

## Compatibility

- Requires Expo SDK 51 or higher.

I have included a tests.ts file with the package. You may try importing it from `expo-sqlite-legacy-adapter/tests`, and it can be run on Expo SDK 51 (with expo-sqlite installed) as follows.
```ts
import { runComparisonTests } from 'expo-sqlite-legacy-adapter/tests';

// Somewhere else
runComparisonTests()
```
Due to limited time, I must admit I relied on LLMs to help create the tests, but as far as I'm concerned it looks to be valid.

Results are as follows, which shows rather compliant behaviour with the original library. I've used this in a few side projects too which should help test its validity somewhat too.

As for the error codes, I cannot guarantee full 100% same behaviour. YMMV. Open to PRs.

```
• Test#1: INSERT returns insertId & rowsAffected=1
 LOG      Expected: [predicate]
 LOG      Legacy : ✔ PASS → {"insertId":1,"rowsAffected":1}
 LOG      Shim   : ✔ PASS → {"insertId":1,"rowsAffected":1}
 LOG  
• Test#2: UPDATE then SELECT yields updated value
 LOG      Expected: 2
 LOG      Legacy : ✔ PASS → 2
 LOG      Shim   : ✔ PASS → 2
 LOG  
• Test#3: syntax error → rollback, no final rows
 LOG      Expected: {"sawError":true,"finalCount":0}
 LOG      Legacy : ✔ PASS → {"sawError":true,"finalCount":0}
 LOG      Shim   : ✔ PASS → {"sawError":true,"finalCount":0}
 LOG  
• Test#4: write in readTransaction throws
 LOG      Expected: true
 LOG      Legacy : ✖ FAIL → false
 LOG      Shim   : ✔ PASS → true
 LOG  
• Test#5: no-callback executeSql silently succeeds
 LOG      Expected: true
 LOG      Legacy : ✔ PASS → true
 LOG      Shim   : ✔ PASS → true
 LOG  
• Test#6: errorCallback returns false suppresses rollback
 LOG      Expected: 1
 LOG      Legacy : ✔ PASS → 1
 LOG      Shim   : ✔ PASS → 1
 LOG  
• Test#7: parameter binding & NULL
 LOG      Expected: [predicate]
 LOG      Legacy : ✔ PASS → {"insertId":1,"rowsAffected":1}
 LOG      Shim   : ✔ PASS → {"insertId":1,"rowsAffected":1}
 LOG  
• Test#8: PRAGMA user_version = 123 → read back 123
 LOG      Expected: 123
 LOG      Legacy : ✔ PASS → 123
 LOG      Shim   : ✔ PASS → 123
 LOG  
• Test#9: UPDATE no match → rowsAffected = 0
 LOG      Expected: 0
 LOG      Legacy : ✔ PASS → 0
 LOG      Shim   : ✔ PASS → 0
 LOG  
• Test#10: multi-statement in one executeSql
 LOG      Expected: undefined
 LOG      Legacy : ✔ PASS → {"mode":"tx-success-no-callback"}
 LOG      Shim   : ✔ PASS → {"mode":"tx-success-no-callback"}
 LOG  
✅ Summary:
 LOG      Legacy failures: 1/10
 LOG      Shim   failures: 0/10
 LOG  🎉 Shim is fully spec-compliant!
```
## License

WTFPL