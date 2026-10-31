# Offline application architecture

The PWA work separates application code, saved evidence, and local drafts. A
cached page never supplies authority to change canonical records.

## Using Vorton offline

Open Vorton online and visit the workspaces and dashboard views you want to keep
on the device. In the installation menu, open **Offline and device storage** and
wait for application code to be ready. That status covers the application code;
records and dashboard data are saved separately as they load successfully.

On iPhone, choose **Share → Add to Home Screen**, then open the saved icon. Use
the same address each time: the custom hostname and private Tailscale hostname
have separate browser storage. Previously visited records can reopen as saved
copies. Unvisited views, deferred Council reports, external map tiles, Rolodex
and live integrations may still require a connection.

Ordinary capture, idea editing, goal editing and task editing keep local drafts
automatically. Routine draft saving is quiet; storage failures and conflicts
remain visible. Local persistence is asynchronous, so immediate process
termination can still lose the latest typing. Once persistent record storage is
ready, an explicit offline Save commits the local record and its queued operation
together. That confirms a device save, not server acceptance. Foreground entry
and reconnect resume synchronization using the same operation identities, so a
lost acknowledgement does not create another record. Conflicts and failures
remain in the connection panel for explicit review. Draft text that was never
submitted stays a draft and is not sent automatically.

**Clear saved records** keeps drafts. **Forget this installation** removes its
saved records and drafts and clears the application's offline code for that
variant. It does not erase server records or the browser's ordinary HTTP cache.
Storage requests can fail or the browser can evict data; the interface reports
local save failures instead of claiming the draft is safe.

Connection status, the last verification time, and Reconnect are available in
**Offline and device storage**. Saved copies remain read-only until live
admission and current records have been checked.

Ordinary navigation displays verified saved application code first while
checking for updates in the background. An explicit browser reload requests
current HTML without HTTP caching and falls back to saved code on network or
server failure. Saved records also paint before live
reads finish. A fully downloaded, verified update replaces an idle page
automatically. An edited form or open dialog defers that reload and exposes an
update button instead. A per-tab guard prevents repeated automatic reloads.
Returning to an open application refreshes admission and current data.

A small red button at the lower left appears when the browser is offline or
Vorton cannot be reached. Open it to test the browser connection hint, Vorton
server, and workspace access separately. The tests contact only this installation
and finish within five seconds, including stalled response bodies. Session and
record reads have an eight-second deadline. Reconnecting refreshes reads and
checks for code updates; it never submits a draft or repeats a mutation.

The original pre-Forge worker cannot update its already rendered document.
The private `/aubos/update-forge` compatibility route bypasses that worker's route
cache and opens Tasks with current code, preserving records and drafts. It joins
the same background upgrade flow as ordinary pages. Its compatibility preflight
waits at most four seconds, followed by at most two seconds checking readiness
before showing the current page. Normal pages do not wait for offline installation.
Normal startup detects and replaces positively identified legacy workers.
Browser registration and update operations have deadlines;
a failed operation exposes a retry in the connection and update control. Normal
foreground checks retry automatically. A legacy client must receive current code
before it can run this behavior; the server cannot replace already cached JavaScript
inside an open document.
Opening another tab alone does not bypass an origin's service worker.

## Application code

The Vite build creates a manifest and a content inventory from emitted browser
modules, styles, fonts, and explicitly selected icons. It does not walk the
private public directory. Dashboard publications and the Rolodex server bundle
must never enter this inventory.

Each inventory entry records its URL, byte length, content type, and SHA-256.
The build identity covers the complete ordered inventory. The offline shell
uses the exact built index bytes. Private and portable variants have separate
identities and cache namespaces.

Service worker updates must finish validating a complete build before making it
available. Failed installation must leave the previous complete build usable.
Verified workers activate without waiting for every window to close. An open
document keeps its running code and unfinished forms; the application decides
whether a reload is safe using the displayed shell's identity. Content-addressed
code stays cached, and the previous complete build can supply lazy-loaded assets
to older tabs offline. Reinstall verifies cached entries instead of trusting a
completion marker after eviction or corruption. Downloads and body reads have
deadlines; incomplete installations cannot become active.

## Installation and records

The host creates a random installation ID at the actual Store root in
`.runtime/installation.json`. It remains stable across process restarts. The
private host passes this identity to its composed LastResort host; standalone
portable hosts have their own identity. Live sessions report the installation
ID and application variant alongside their process-scoped token.

Include installation metadata in recovery backups. A new source-only
installation generates its own ID. Copying another installation's identity
defeats the distinction. Invalid metadata causes a service error and requires
repair from verified metadata, rather than silent replacement.
The existing core-record backup and isolated restore command does not preserve
this identity. A full installation recovery must also restore the original
Store root's `.runtime/installation.json`; an isolated test restore should
receive a new identity.

Saved evidence belongs to an installation, variant, profile, and schema. A
dashboard view or part also belongs to its exact snapshot and content hash.
Restoring evidence must preserve its original verification time and must not
overwrite a newer network response or completed mutation.

A live identity change or profile removal stops display of previously admitted
records. Drafts retain their original scope for recovery. An offline browser
cannot discover a server replacement it has never contacted, so saved evidence
must identify itself as a previously verified copy, not current authority.

## Drafts and reconnecting

Ordinary capture and editor drafts contain form fields, relationships, and the
revision or entity version from which editing began. They do not contain a
queued canonical command or a persisted session token.

Restoring a draft does not silently move its baseline to the latest revision.
Changed records require explicit review. Reconnecting refreshes admission and
records; it never submits a draft. If a request might have reached the server
but its response was lost, preserve the draft and report an unknown outcome.
Do not retry it automatically with a new request ID.

Clearing saved reads preserves drafts. Forgetting local data must also fence
pending writes and notify other tabs so late responses cannot recreate deleted
records. Custom storage controls cannot promise to erase the browser's ordinary
HTTP cache.

## Acceptance

Verify cold offline reopening, visited and unvisited routes, profile isolation,
identity replacement, interrupted updates, multiple tabs, storage failure,
draft restoration, conflict handling, and reconnect without automatic writes.
Use synthetic records for destructive or mutation checks.

Responsive browser checks do not establish physical iPhone behavior. Test Home
Screen installation, background return, process eviction, and airplane-mode
reopening on an actual device before claiming those outcomes. Safari storage
can be evicted; persistence requests are advisory. See the
[WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).
