# Local recovery archives

Status: archives, resource mapping, command-line recovery and application wiring
pass isolated tests. A full-sized private rehearsal restored every managed file
and the imported record state. Independent delivery review and managed activation
remain pending. No live backup service change has been activated.

The daily service checks at server startup and hourly while the server runs.
It coalesces concurrent work and reuses a verified dated archive after reopen.
Automatic capture and restore verification run in one temporary Node worker,
so synchronous SQLite checks do not block the application's HTTP thread. Stop
waits for that worker to exit and preserves the previous archive on failure.
The existing host shutdown deadline can still interrupt a long capture; this
does not make a partial archive authoritative.
Same-day checks within one process skip another full restore. Archive names and
retention use UTC dates. This creates no external scheduler and promises no work
while the server is stopped.

Create or verify today's archive with `npm run backup`. For a portable custom
workspace, supply `--root` and `--profile`; additional managed resource roots use
`--resource`. Inspect the recorded resource selection in the archive manifest.
An existing daily archive must match the requested installation and resource
selection. A different profile, resource set or installation fails explicitly;
use `--directory /private/path/separate-backups` for a separate archive series.
Equivalent selections can reuse the day's earlier snapshot. Later changes to
files already in that selection do not refresh the existing daily archive.

Restore without activating an installation:

```sh
npm run backup -- --restore /private/path/daily.zip --into /private/path/new-restore
```

Each daily ZIP contains a consistent snapshot of each configured SQLite database,
its complete operation receipts, explicitly selected managed files and restore
configuration. The application adapter owns that resource inventory. It must
include managed attachments and referenced evidence, rather than just SQLite.
External files and unavailable historical sources must be identified separately;
a successful archive cannot certify resources it never included.

Files are staged before the database capture, then checked for changes before
publication. New or replaced resources cause capture to fail and retry later.
External writers that replace and restore files between observations require
writer exclusion or a filesystem snapshot for a stronger consistency guarantee.

SQLite creates its snapshot with VACUUM INTO, including committed WAL contents.
The source database is not rewritten. ZIP streams keep file contents out of
unbounded memory buffers. The implementation uses
[yazl](https://github.com/thejoshwolfe/yazl) and
[yauzl](https://github.com/thejoshwolfe/yauzl) rather than a custom archive format.

Before publication, the archive is restored into a new disposable directory.
Verification checks every described file, database integrity and table counts.
Database verification runs after extraction finishes; live WAL, journal and
shared-memory sidecars cannot accompany a snapshot database.
Unsafe paths, duplicate names, symlinks, missing entries and changed content
reject the restore. Partial restore directories are removed. Existing targets
are never overwritten, and restoration does not activate a running service.

Only a verified archive can become that day's backup. Concurrent attempts publish
one archive. Successful publication prunes daily archives older than 90 days;
separately named migration backups and operator exports remain untouched. Failed
capture or verification leaves prior archives intact.

Archives are private local files without application encryption. Users supply
Time Machine or an equivalent off-device backup. The integration vault retains
its existing ciphertext; its keys remain a separate recovery dependency. The
reserved integration secrets directories are rejected at every nesting level.
Configured integration key files are excluded by their exact paths, including
keys inside a managed files directory. Nested workspaces receive separate vault
snapshots and keep their keys outside the archive. Native resource coverage does
not depend on which frontend serves the installation. Missing required workspace databases fail
capture instead of silently reducing the backup's scope. A file
digest detects corruption and accidental changes, not a malicious owner who can
rewrite both content and manifest.

Restoring over a server history requires a new sync-generation identity before
client access resumes. Preserve device outboxes and offer explicit reconciliation.
The isolated archive API preserves the captured database exactly and performs no
automatic cutover or generation reset.

The shared store provides a trusted history-adoption operation for a verified
restored snapshot under managed writer exclusion. It changes the generation,
advances the workspace revision and records the maintenance event and retry
receipt atomically, preserving entity values and existing sync receipts. It is
not an HTTP action and does not run during startup or isolated restore. A retry
returns its historical result; the installer must verify the current generation
before admitting clients. Client comparison and adoption have separate isolated
regressions; this operation alone is not a complete recovery or installation
procedure.

After accepting SQLite writes, recovery must preserve the current database and
its receipts. Reopening retained CSVs with the pre-SQLite application would lose
those writes. Keep that source export as migration evidence, not a writable
fallback. Restore a verified archive into a new directory, validate it with a
SQLite-capable runtime, then adopt the restored history under managed writer
exclusion before admitting clients. If the runtime cannot read the restored
schema, retain the archive and use a reviewed forward repair rather than starting
the old writer.

The private isolated recovery rehearsal preserves a post-import write, both
auxiliary stores and the complete retained source export. It also verifies that
history adoption rejects old-generation requests and replays an accepted
operation without another mutation. This covers recovery with the current
runtime, not backward compatibility with the pre-SQLite application. Full managed
file restoration has separate archive evidence; live cutover remains unverified.

The older logical JSON export remains readable for compatibility. It lacks the
complete SQLite receipt history and managed files, so it is not a full archive.
The private legacy tool requires `--legacy-json` to create that limited export.

## Isolated format preparation

The `prepare-workspace` command prepares a new restored copy from an exact
archive digest through `prepareWorkspaceMigration`. It retains the verified archive outside the
restored runtime subtree and accepts only explicitly selected, manifest-listed
workspace databases. Existing output directories are refused.

```sh
node scripts/prepare-workspace.mjs --archive /private/path/daily.zip \
  --sha256 REVIEWED_ARCHIVE_SHA256 --into /private/path/new-preparation \
  --database WORKSPACE/state/core.sqlite3
```

Supply the reviewed archive's full SHA-256 digest and exact database paths from
its manifest. Repeat `--database` for each workspace database to migrate. The
`.ts` entrypoint accepts the same arguments. Neither entrypoint discovers a live
installation or accepts activation or writer-exclusion flags.

The trusted migration adapter must preserve complete workspace values,
generations, record revisions, feed cursors, receipts and retained exports.
Preparation checks those invariants, closes and checkpoints the databases,
verifies untouched resources, flushes the files and publishes its receipt last.
A directory without `preparation.json` is incomplete and is not resumable
success. A failed preparation removes only its newly created directory.

This helper never migrates an existing installation or starts an application.
Its writer exclusion applies only to the new, unopened restored copy. Activating
that copy still requires managed exclusion of live writers, current-state
verification and explicit restored-history adoption. Synthetic tests cover the
real normalized adapter, both command aliases, format conversion and format-2
no-op preparation. Exact delivery, full recovery and live activation remain
separate acceptance gates.
