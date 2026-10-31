# Changelog

## Unreleased

- Publish completed canonical ingestion even when an earlier replica synchronization updated the display while it waited. Preserve cancellation by newer reads, writes and authority changes so a confirmed Council decision does not remain stale until the next poll.

- Run test files sequentially so responsiveness assertions do not compete with unrelated suites for the container CPU budget. Preserve timing limits and explicit concurrency within tests.

- Share bounded backoff and jitter across browser admission, reads and delivery within each workspace scope. Preserve saved operation identities, cancel owned work on teardown and distinguish explicit retries from automatic reachability recovery. Verify local and server storage failures separately while preserving unrelated pauses. GET-only admission and server verification send no queued work; returning from this read-only recovery requires a later explicit reconnect. Device-storage retry verifies locally before attempting synchronization. Obsolete cache comparisons remain canceled reads rather than storage failures.

- Run portable and private workspace HTTP reads, commands and response encoding in one bounded worker shared by the outer host and nested demo. Keep tuning validation, staging and built Rolodex handling in the worker; retain guarded native effects and reconciliation evidence in the parent. Preserve admission, replay and history checks, and drain owned resources before shutdown callbacks. Portable and synthetic native responsiveness checks pass; final artifact and live acceptance remain pending.

- Install shutdown handlers before worker readiness and recovery. Startup signals drain owned work without later opening a listener; the host's forced shutdown deadline reports uncertainty and exits unsuccessfully.

- Add awaitable delivery of encoded JSON bytes, preserving compression and HTTP metadata while retaining response capacity until delivery finishes or fails. A stalled client bounds queued work without blocking health requests.

- Update Vite, the optional PDF sanitizer and the schema validator's URI dependency to patched versions identified by the release dependency audit.

- Extract installation-specific presentation into validated, snapshot-bound private payloads. New snapshots start without presentation; current planning records cannot replace dated briefing evidence.

- Update the browser test dependency to Playwright 1.64.0 for its WebKit offline-emulation fix. Keep strict browser assertions and separate rapid-navigation and destination acceptance checks.

- Add explicit backup-based format preparation with pinned input, retained-history checks and a durable completion receipt. Both command aliases prepare an isolated copy without activating it.

- Store workspace records, ordered collections and auxiliary values in normalized SQLite rows with sparse transactional updates. Require explicit verified migration for older storage and reject corrupt collection descriptors before publication. Worker responsiveness has component evidence; exact delivery validation remains required.

- Show a neutral saved-session link on Bridge for Councils without a CEO role, instead of reporting a missing CEO submission.

- Separate private application code and assets from the configured runtime root. Keep configuration, SQLite and backups runtime-scoped, and refuse unsupported split legacy companions before initialization.

- Provide distinct installed Omi and legacy logical-backup entrypoints so private assemblies preserve the portable command names.

- Typecheck the direct private server entrypoint while preserving port admission, automatic backups and signal handling.

- Typecheck nightly Council admission and command execution while preserving evidence completeness, bounded attempts and publication replay.

- Typecheck Council tuning and its operator commands while preserving history-bound completion, recovery evidence and preview admission.

- Typecheck private activity observation and its command entrypoint while preserving host identity, metadata privacy and delivery-evidence boundaries.

- Typecheck host startup, shutdown and optional Factory installation admission while preserving the existing managed lifecycle and disconnected fallback.

- Typecheck Omi workflow and shared command execution while retaining explicit portable workspace admission and private transcript output boundaries.

- Typecheck private HTTP routing and Factory command admission while retaining existing origin, session, history and asset boundaries.

- Move encrypted integration storage, Omi reads and integration HTTP admission into checked TypeScript and include their compatible entrypoints in portable exports.

- Typecheck native backup commands, legacy logical recovery and the portable backup launcher while preserving their distinct recovery scopes.

- Typecheck local configuration and Council review/publication commands while preserving their existing command-line entrypoints.

- Typecheck private asset confinement, planning admission, retained evidence and Rolodex composition while preserving compatibility entrypoints.

- Typecheck the portable launcher and fictional seed implementation while preserving existing commands and explicit seed admission.

- Typecheck shared asset delivery, JSON compression and offline inventory admission while preserving existing module entrypoints and worker validation.

- Convert shared commands, HTTP admission and Council publication to checked TypeScript with compatible module entrypoints and typed helper contracts. Include the typed runtime in portable exports.

- Bind Council tuning and Rolodex browser saves to the server history that supplied their records. Keep open drafts bound to their original history when background refresh detects a restore.

- Include portable PWA endpoint and worker coverage in the publication export. Keep private adapter assertions in a separate local test and retain strict WebKit lifecycle diagnostics.

- Recognize linked Git worktrees when selecting native package source while retaining manifest verification for detached packages.

- Move shared Council configuration to checked TypeScript while preserving valid organization extensions and advisory authority limits. Reject missing identity IDs and behavior extensions that are not objects.

- Protect standalone unsaved controls during code updates, including the Council import buffer. Exempt only known view preferences and filters, release protection on explicit clearing, and keep delayed page admission from stealing typing focus.
- Resume automatic code updates after successful editor saves and filter blur. Preserve focused filters when only the query changes, protect unsent forms and wait for final draft writes after an editor closes. Keep the explicit reload action disabled while local edits need protection.
- Retain the service worker's activation request in the install event lifetime after verified startup preparation. Observe actual worker state separately from its protocol acknowledgement. Keep existing documents and their unsaved fields intact during replacement.
- Require browser commands to identify the reviewed server history. Reject old cached interfaces before domain execution, retain local work and preserve trusted CLI baselines and operation receipt checks.
- Run automatic backup capture and complete restore verification in a temporary Node worker. Keep HTTP responsive during SQLite checks, wait for worker exit on shutdown, retain prior archives on failure and carry the running process's captured version into the manifest.
- Discover retained task, goal and idea editor drafts through recovery-copy identities. Keep source storage keys, require explicit selection, reject changed or competing drafts and preserve history identity when clearing downloaded reads. Do not infer deletion from a recovery copy's technical absence marker. A reappearing original cannot load its copy's draft.
- Recover interrupted local attempts through reviewed copy identities, retain newer capture text and update the existing copy after explicit review. Fence networking at page teardown, abort in-flight requests and resume original operation identities on foreground entry. Handle hydration cleanup rejections without creating an orphan promise.
- Require review of retained drafts that lack a server history identity before local or online submission. Keep their text intact, retain the adoption counter across read clearing and reject unbound worker saves after adoption. Phone regressions cover review and one explicit save after clearing saved reads.
- Add restored-history review to the connection popover with scrollable differences and separate provenance labels. Share its preview planner with adoption, preserve paused work through browser reopen and require an explicit copy decision. Keep fresh read admission evidence separate from cached display, and allow authenticated local review while ordinary command authority is paused. Draft identity integration remains unfinished.
- Wire restored-history comparison and confirmation through the SQLite worker and scoped foreground service. Resume interrupted downloads, recheck current server history before adoption, recover lost confirmations by exact receipt and allow an explicit fresh comparison after another restore. Interface controls remain in progress.
- Preserve original local attempt and record identity through restored-history recovery copies. Commit copy links with conflict resolution, follow later copies after reopen, retain explicit server/deletion outcomes and reject reuse of an earlier server history identity. Draft and interface integration remain in progress.
- Add an atomic device history-adoption primitive with retained comparison archives, durable confirmation replay and blocked recovery proposals. Distinguish queued intent, historical acceptance and cached history; retain explicit deletions and the adoption counter. The interface and draft identity integration remain unfinished.
- Add persistent replacement-history staging in the device kernel. Keep original records and queue intact during download, fence sends and edits during review, retain recovery exports and treat late acknowledgements as historical proof without publishing into replacement records. Adoption controls remain in progress.
- Capture SQL workspace metadata with its record cursor, and refresh metadata during foreground synchronization even when no local edits are queued. Use a smaller replica response, preserve partial download progress and prevent newer staged metadata from making an older record boundary ready.
- Add a trusted restore-history transition that changes generation, advances the workspace revision and records its durable maintenance receipt in one transaction. Preserve records and sync receipts, reject reuse across command transports and keep history adoption outside HTTP commands and automatic startup.
- Bind drafts and prepared local saves to their server history, even when numeric revisions repeat after a restore. Recheck history inside server command and sync transactions, preserve old save identities for recovery and review locally bound captures against their existing record.
- Capture one server change boundary per download attempt so writes arriving between pages cannot make offline preparation chase a moving target. Bind later pages to the same server history, preserve cursor progress and reject a shrinking incomplete download boundary.
- Move task, goal, idea, recommendation and financial input validation into TypeScript using shared domain types. Preserve existing validation rules, retained long text and compatibility exports.
- Save private Rolodex notes and views through the shared SQLite command transaction. Preserve imported fields and retained JSON, reject stale saves without another audit entry, and require the host to configure authoritative storage instead of falling back to a JSON writer. Typecheck the private server bundle explicitly.
- Read Council workbench history and tuning provenance from SQLite in both supported native directory layouts. Retained JSON cannot replace imported instructions or model provenance.
- Save Council tuning versions and run receipts in the shared workspace SQLite transaction. Block unimported private JSON rather than treating it as empty, reject concurrent workspace changes and keep auxiliary records out of planning responses.
- Replace Council supervision's Python lock helper with a typed Node SQLite process lock that releases after failure or process death. Its separate lock file holds no application records.
- Remove the native planning service's Python fallback. Require verified SQLite initialization before admitting planning reads or writes, and apply native governance independently of frontend routing. Retained CSV exports no longer act as a competing database.
- Apply the same verified-import gate to private Council, nightly Council and review commands when no companion server is configured.
- Snapshot nested integration vaults without their keys or live sidecars. Keep native backup coverage independent of frontend mode, exclude configured key files and reject daily archive reuse for a different installation or resource selection. Support a separate backup directory for another archive series.
- Add streamed daily ZIP capture and isolated restore verification for complete SQLite databases, receipt history, managed files and recovery configuration. Wire startup and hourly checks into application entry points, keep integration keys separate, preserve prior backups on failure and retain ninety daily archives without pruning migration backups. The full-sized private rehearsal passes; managed activation remains pending.
- Use SQLite transactions and revision checks for writer concurrency, so a crashed directory lease cannot strand a workspace. Reload the authoritative initialization winner before preparing commands or evidence checks. Fence the retired CSV writer after SQLite cutover and read current Council sessions from SQLite. Route Council and review publication through the shared command service.
- Preserve governed completion outcomes and reject missing or duplicate outcomes at restore and publication. Record planning changes and owner recommendation decisions in the same SQLite commit. Retain the native task-to-goal source validation boundary without applying it to unrelated Forge overlays.
- Retain accepted save confirmations when clearing read copies, so uncertain local drafts can still resolve their original record. Include saved drafts in recovery exports. Reject conflict decisions if the reviewed local revision or queue tail changes, and require another comparison before confirming the server version.
- Keep every pending change inspectable in the connection popover while offline, reconnecting or failed. Show each title, operation and acceptance state, retain connection diagnostics, compare conflicting fields and offer explicit server/local resolutions without discarding recovery history. Phone tests cover twenty task rows, offline goals and ideas, reopen, interrupted saves and both conflict choices in Chromium and WebKit.
- Allow verified cached assets during reload requests so an offline reload can load its startup scripts. Keep document freshness separate from versioned asset delivery.
- Resolve interrupted local saves by their durable operation identity, preserve newer draft text and bind its next save to the existing record. Persist the saved local version instead of reconstructing it from a patch. Fence old worker requests after device clearing and offer a local recovery export before forgetting pending changes.
- Connect supported Forge editors to atomic local saves and foreground synchronization. Distinguish device durability from server acceptance, retain uncertain attempts and keep newer capture text attached to its original record. A production-build phone fixture creates twenty tasks offline; queue controls and full lifecycle acceptance remain unfinished.
- Stage downloaded workspace metadata until its server generation is validated, reject incomplete initial replicas inside the enqueue transaction and retain queue diagnostics when storage fails. Require the SQLite worker and WASM engine before switching application code. Serve upgrade bootstraps as separate scripts under the existing Content Security Policy.
- Add worker transactions for queued edits, server change cursors and receipt reconciliation. Preserve later local edits, imported text and existing worker data across additive upgrades. Persistent Chromium and WebKit storage fixtures pass; editor integration remains in progress.
- Add authenticated synchronization endpoints with record revisions, durable receipts and ordered changes. Route explicitly migrated AubOS workspaces through the shared SQLite writer, preserving completion outcomes, assessment fields and retained legacy data. One-time migration rehearsal passes; live cutover remains pending.
- Prepare verified startup files before activating PWA updates, then download remaining offline assets separately. Show prepared and running versions, offline coverage and retryable download failures in connection details. Retain open documents and local work during activation. Historical browser acceptance remains in progress.

- Move portable workspace commands and isolated backup restoration to SQLite. Preserve legacy JSON exports and fail closed when another writer changes an imported export. Native AubOS migration and offline delivery remain unfinished.
- Add isolated SQLite replica primitives with durable operation receipts, conflicts, tombstones and lossless source-export retention. Add an initial SQLite WASM worker for atomic local records and pending operations. Application integration and offline acceptance remain unfinished.
- Resolve Council transitions with the running server's Node executable so managed environments do not depend on Node being on Python's PATH.

## 0.2.0-preview.36

- Animate the floating creation button width and crossfade its caption during navigation. Respect reduced motion and keep the button stationary on hover.

## 0.2.0-preview.35

- Consolidate Tasks into List and Board. Move view, grouping and status controls to the sidebar. List groups by Status, Due date or Goal; saved Agenda and By goal preferences migrate to the equivalent List grouping.

## 0.2.0-preview.34

- Keep completed tasks out of the active Board. Switch between Active and Done from the left sidebar, with the same controls above the board on mobile. Completing a task keeps the active board open.

## 0.2.0-preview.33

- Remove the Tasks Focus view. Saved Focus preferences now return to List; Agenda, By goal and Board remain available.

## 0.2.0-preview.32

- Keep Ideas cards and chart bubbles stationary on hover. Document the prohibition on hover movement in the contributor guide.

## 0.2.0-preview.31

- Open the current interface while offline code prepares in the background. Detect legacy workers during startup, bound stalled browser operations, and retry through shared update controls. Bound compatibility waits instead of waiting indefinitely for offline installation, and stop probing workers while they are retiring.
- Extend mobile Forge filter rails to the viewport edges with gentle fades and content-aligned starting positions. Record the shared scrolling convention in the contributor guide.
- Remove redundant page titles and captions that repeat the active toolbar label while retaining section and record headings. Consolidate Forge creation into a captioned floating button.
- Replace an unrated Ideas chart with an assessment prompt. Plot and rank only rated ideas rather than assigning rankings from missing scores.

## 0.2.0-preview.30

- Retire the obsolete root service worker before leaving the recovery route, and wait for its replacement before displaying Tasks. Closing recovery and opening Tasks in another tab can no longer reuse the original worker registration. Preserve saved records, drafts and code caches while preparing the replacement.

## 0.2.0-preview.29

- Default Tasks to a compact List at the same width as Goals and Ideas. Add remembered Focus, Agenda, By goal and Board views while preserving the existing editors and guarded task actions.
- Move task suggestions into a separate collapsible review section. Replace purple dashed suggestion treatments across Forge with neutral surfaces, solid outlines and explicit unconfirmed labels.

## 0.2.0-preview.28

- Honor explicit browser reloads by requesting current server HTML, including Safari reloads labeled as ordinary cached requests. Retain cached-first ordinary navigation and an offline fallback. Do not present an older offline controller as an update when fresh HTML is already displayed.

## 0.2.0-preview.27

- Clear acknowledged action errors when refreshing records or changing Forge views. Avoid duplicating rejected quick-action errors in the page notice; preserve uncertain-save review gates and never retry a mutation automatically.

## 0.2.0-preview.26

- Explicitly activate verified waiting updates in browsers that defer the install-time request. Keep the reload action disabled until the replacement is active, and keep worker update checks outside navigation fetch events.

## 0.2.0-preview.25

- Load verified cached pages first and check for new code in the background. Automatically display verified updates on idle pages, preserve edited forms, and prevent reload loops.
- Add a shared lower-left offline button with bounded server and workspace connection tests. Bound session and record reads without retrying mutations.
- Repair incomplete same-build caches and serve retained previous-build assets to offline tabs. Verify cached entries and bound downloads before activating updates.

## 0.2.0-preview.24

- Fetch current HTML on online navigation and reload, even while an older offline build remains installed. Use verified saved HTML only for network failures, server outages or a five-second timeout. Preserve access-denied and not-found responses, local drafts and offline reopening.

## 0.2.0-preview.23

- Add a direct Forge update route that bypasses an older cached document, loads current application code and returns to Tasks without clearing saved records or drafts. Verify the transition from the old application in WebKit.

## 0.2.0-preview.22

- Activate fully verified offline updates without waiting for every app window to close. Open documents and unfinished forms remain intact; the next navigation loads the updated interface. Failed downloads cannot activate, and the previous complete build remains available for rollback.

## 0.2.0-preview.21

- Redesign Forge. Tasks use a simplified board with Suggested, To do, In progress, Blocked and Done columns, drag and drop, arrow-key moves and completion checkboxes.
- Goals use focused goal pages: progress ring, why and done-when, a checkable milestone timeline, the goal's tasks and stage changes, with an All goals overview and a goals list in the rail.
- Ideas use a notebook grouped by stage with quick stage actions, plus a value against effort chart with a ranked list and a needs-assessment strip.
- Show Council suggestions as unconfirmed items in every view, with confirm, edit, later and decline. Suggestions never count toward progress. Search, project and tag filters apply to them.
- Keep the guarded save behavior: full field updates with revision checks, editors that open offline for drafts, and a blocking review after any save with an unknown outcome. Governed records keep their completion evidence and follow-up guidance.

## 0.2.0-preview.20

- Move Forge's Tasks, Goals and Ideas into the shared second toolbar row and remove the Forge breadcrumb trail.
- Float Forge search, project, tag and idea filters in a rail at the viewport's left edge, matching the Council "On this page" rail. Narrower screens show the filters as a compact row above the content.
- Place quick idea capture below each view's heading so the page title leads.

## 0.2.0-preview.19

- Update the private application's Next dependencies to 16.3.8.
- Preserve donut chart labels while rendering SVG titles consistently during server hydration.

## 0.2.0-preview.18

- Apply the existing browser asset confinement checks to the legacy host. Symlinks cannot expose files outside the build or alias server output as browser assets. A synthetic-file regression covers GET and HEAD while preserving ordinary asset delivery.

## 0.2.0-preview.17

- Escape dismisses all open theme tooltips and restores the saved appearance when keyboard focus and pointer hover belong to different swatches.

## 0.2.0-preview.16

- Preserve keyboard-focused theme help and previews when the pointer leaves the control. Keep rich descriptions reachable across the tooltip gap and restore the saved theme when the window loses focus.
- Retain tooltip placement when a pointer enters an already focused control. Add desktop and phone checks for focus, description traversal and preview cancellation.

## 0.2.0-preview.15

- Add Freed-style theme tooltips, compact pill selectors on desktop and touch layouts, descriptive accessibility labels, and per-swatch preview cancellation without changing the saved theme until activation.

## Forge

- Bring Overview, Tasks, Goals and Ideas together under Forge in the shared navigation. Keep old task, goal and opportunity links working and move Organization into Admin.
- Add quick idea capture, cards grouped by readiness or project, shared project/tag filters, optional value and complexity assessments, review dates, start conditions and small experiments.
- Preserve original captures, legacy opportunity details and record history. Graduate ideas into new or existing goals with explicit owner action and scoped links.
- Let Council propose ideas, idea revisions and graduation into goals. Bind changes to the reviewed record version and retain owner acceptance.
- Show AubOS idea and opportunity sources through the native writer adapter, with Forge additions retained under its existing transaction lease. Keep canonical goal and task registers authoritative.


## Unreleased

- Align offline guidance and update notices with quiet automatic draft saving.

- Make both fixed toolbar rows fully opaque in every theme and remove their backdrop blur.

- Open Forge to Tasks, with views and search in a left sidebar. Replace Overview with compact task checkboxes and matching goal and idea cards.
- Narrow Bridge, remove Daily focus, and navigate its sections from the page sidebar. Make planning column headings and Admin cards complete link targets.
- Share thin foreground headings and breadcrumbs across native and private pages. Move Council's timeline upward and scope Review to the selected dated session, removing unrelated current goals.
- Expand floating capture with Task, Goal and Idea choices, multiline text and a full-width Save button. Close after confirmed saves, retain recoverable drafts quietly, and keep confirmed server success separate from stale local display updates.

- Remove routine saved-record and connection banners from page content. Keep connection details and Reconnect in the existing offline and device storage dialog.

- Keep installed-app title bar tint in sync with the selected appearance, including saved startup themes, temporary previews and changes from another window.

- Open a floating idea capture card from any AubOS page, preserving local drafts and loading planning records only when opened. Use the shared fixed Forge submenu in every workspace and expose idea editing directly on each card.
- Complete and reopen tasks from their rows with current revision checks. Keep governed completion history closed and offer a follow-up instead. Require an explicit review of current records after an uncertain save response.
- Remove agent-prompt copying from native and private dashboards while retaining source evidence, recommendation import and record editing.

- Add an installable application shell with verified offline code, coherent updates across open tabs, and device storage controls. Keep application code separate from saved private records.
- Restore previously verified workspace and dashboard copies after document loss. Refresh admission and active data on foreground return without reloading the page, and require live authority before canonical writes.
- Scope saved records to the installation and workspace. Preserve local drafts when clearing saved reads; forgetting local data fences pending storage work.
- Keep ordinary idea capture, idea edits, goals and tasks as local drafts across document loss. Require explicit online submission and review when their baseline changes; never replay drafts on reconnect.

- Keep shared navigation independent of Forge rendering so unrelated screens do not load the editor at startup. Reuse validated content-addressed dashboard views and parts through private browser caching while keeping mutable manifests and planning reads fresh.
- Prepare admitted direct routes with the existing code-and-data loader, and bypass cached payloads on retry after failed validation.
- Include every column of horizontally scrolling Finance tables in PNG and PDF exports without changing the live mobile layout or scroll position.

- Serve the private Vite application directly through the existing Node host, including the canonical Rolodex handler. Preserve the separate portable build and workspace storage boundaries.
- Compress private and portable JSON responses with negotiated Brotli or gzip while retaining private cache policy.
- Keep one shared client shell across admitted organizations, cache canonical reads by profile, and prepare destination code and data on navigation intent. Build the private browser application without the framework runtime.
- Render Forge idea summaries first and open rich details on selection. Index search and relationships once per dataset, isolate capture typing, and restore focus after editing.

- Replace the Bridge's full Council embed with the compact CEO orbital portrait and an always-visible briefing beside it. Stack the columns on phones and preserve the full Council link.

- Add an opt-in read-only Vorteo activity observer and AubOS console view. Retain bounded attributable thread metadata and Council evidence without importing transcripts or treating completed turns as shipped work. Show stale observations, disconnection and missing coverage explicitly.

- Restore theme colors on the AubOS and FreedOS workspace selector by removing the graphite brand override. Dock and installation icons retain their existing artwork.

- Add an opt-in availability policy for the installed Vorton service. Recover stopped services through the managed broker, retain retry state across monitor restarts, and continue retries with capped backoff. Pin the service definition, support expiring maintenance pauses, and report custom hostname outages separately from application failures.

- Connect prepared release admission and its native-bound driver to source assessment. Recheck retained context and exact provider authority before preparation, and retire stale or rejected assessments without satisfying build requests. Runtime activation remains pending.

- Capture bounded immutable release-source evidence and assess it through the existing native quota, custody and cancellation path. Keep packets outside queue history, retain settled assessment replay and include retired source reviews in recovery. Installed admission and decision verification remain unwired.

- Separate release-source review admission from permission to prepare a release. Retain rejected source evidence and pending requests, require native acknowledgment before the next candidate, and suppress repeated review of unchanged rejected inputs. The governed source assessor is not yet wired into the installed coordinator.

- Show retained build requests, verified daily-release timing and external release ownership in the Factory view. Distinguish stored progress from a connected coordinator or a running worker.

- Import each retained release source into both private Git stores before worktree creation. Preserve import custody across recovery and leave checkout heads unchanged.

- Reconcile independently published dev builds through the existing release verifier. Preserve external provenance and original publication time, satisfy only covered requests, and hold new release work while an external owner remains active or uncertain.

- Transfer reviewed release candidates from their linked preparation worktrees without relaxing worker isolation. Keep publication settlement checks within the active operation.

- Prepare isolated release-review and validation workspaces through the existing worker helpers. Preserve bootstrap custody across restart and retain the bounded candidate ancestry needed for actual feature validation.

- Connect build publication to Freed's existing cloud controller with retained dispatch and policy-collector custody. Bind one exact challenge, preserve its deadline, and reconcile uncertain responses without duplicate dispatch. Require all publication helpers to settle before completion or retirement.

- Wait for merged dev integration before starting release-tag publication. Keep pending checks in the native polling flow and refuse missing checkout-readiness results.

- Provision retained release checkouts through the repository worktree helper. Keep preparation and publication in separate Git stores, preserve helper custody, and reuse one registered execution workspace after restart.

- Keep nightly Council reviews running when Omi returns otherwise eligible recordings with empty transcripts. Disclose skipped counts while retaining strict gates for malformed, locked, explicitly unfinished or unavailable evidence.

- Bind release preparation adapters to each retained operation before workspace provisioning. Reopen the same checkout identity after interruption and recover historical custody without creating new workspaces.

- Connect the native build runner to retained release preparation, review, validation, PR merge and tag publication stages. Discover exact release workflow runs and preserve failed gates as durable holds.

- Publish release preparation PRs through the repository helper with separate draft and READY custody. Recover lost responses from successful native outcomes and exact remote readback; hold failed helpers without repeating publication.

- Retain release preparation PR merge intent in the build journal, recover lost merge responses, and bind tag publication to the verified squash commit.

- Connect build schedule admission to the persistent queue and daily release planner. Reconcile active releases first, preserve request identities across retries, and require the same source checks for scheduled and explicit requests.

- Route a dedicated native build schedule through the persistent coordinator with shared account governance, durable CI polling deadlines, same-run resumption and terminal acknowledgment replay.

- Retain exact native build-run bindings and terminal acknowledgment receipts across coordinator restart. Block the next release until the prior native completion is confirmed.

- Reconcile retained release accounting before Factory admission. Finalize completed executions with fresh telemetry and preserve interrupted or manually paused work without replaying commands.

- Include retained build-coordinator custody in Factory account-lock recovery. Require exact release reservation identity and native settlement without manufacturing an issue claim or resuming interrupted work.

- Execute release validation through native account governance and the existing sandboxed command client. Retain exact-source outcomes and refuse publication after failed or unsettled validation.

- Materialize the retained release approval by fast-forwarding its clean, owned preparation branch. Preserve dirty or foreign checkouts for reconciliation and retain the exact commit/tree for validation.

- Apply settled release editorial approval as an immutable one-field commit without changing the working checkout or Library activation decisions. Retain the commit for subsequent validation and protected publication.

- Run release editorial assessments through the existing native governor with account limits, retained custody, read-only workspaces and candidate-bound results. Preserve interrupted reviews for reconciliation.

- Capture release-review input directly from the generated Git draft and retain its exact content identity. Refuse dirty, unrelated, mismatched or prematurely approved drafts.

- Connect release-candidate generation to Freed's existing dev preparation script with durable source intent and native custody. Preserve draft status and require subsequent review, validation and protected publication.

- Connect prepared dev-release publication to the existing repository tag publisher through retained native custody. Reconcile interrupted commands without launching duplicates, and require separate remote release verification before acknowledging requests.

- Allow settled failed dev releases to retire into preserved history after fresh remote failure verification. Requests remain queued, and failed operation, tag and run identities cannot be reused for another release.

- Allow the local Vorton host to connect an explicitly configured, owner-controlled Factory adapter. Unconfigured installations remain offline; read-only adapters expose status without enabling controller commands.

- Retain the build coordinator's exact publication identity and distinguish running, failed and verified release workflows across recovery. Failed builds keep their active intent and cannot acknowledge requests or satisfy the daily release target.

- Prepare continuous Factory qualification, governed dispatch, checked merge recovery, and a coalescing dev-build queue. Retain audits and interrupted operations, enforce the native account policy, and require reviewed host activation before unattended execution.

- Add bounded Factory CI repair with exact-job diagnostics, renewed validation and independent review, same-PR publication recovery, and archived parking that does not count failed work as delivered.

- Connect Factory READY promotion to the trusted repository helper with retained custody, exact publication checks and lost-response recovery. Preserve provider gates and installation holds.

- Require merged Factory deliveries to enter the persistent dev-build queue before claim release, with authenticated sender identity, independently verified merge receipts and deduplicated recovery.

- Correct Safari Dock Clear rendering with installation-only padding around the complete AubOS and FreedOS emblems. Preserve their paths and proportions, compact favicons, inline marks, installed identities and prior asset URLs. Match Vorteo's RGB touch and 192/512-pixel manifest packaging; native comparisons showed padding, not packaging alone, resolves the flat background.

- Keep iOS Home Screen toolbars sharp with a default status bar and an invisible, theme-aware WebKit color extension. No extra toolbar padding is added. Replace an existing translucent Home Screen shortcut through Safari, keeping the old shortcut until the replacement and its saved settings work.

- Apply the approved plain Vorteo source treatment to AubOS, FreedOS and Vorton installation assets. Add FreedOS pinned-tab branding and Vorton touch icons, retain prior asset URLs and installed identities, and leave inline symbols theme-aware.

- Refresh private AubOS brand tiles with solid graphite and white, retain original falcon and insignia geometry, and publish versioned Safari, touch and installation icons while preserving older assets and installation identity. Enlarge Vorton's angular V and inner wedge in its neutral logo and favicon.

- Expand Council Tuning into a wider private day/session workbench with retained context inventory, coverage gaps, central and individual voice rules/output inspection, scoped coaching drafts, rule/output line comparisons, and exact session/bundle preview binding.

- Council history distinguishes certified scheduled nights from actual Pacific publication times and labels catch-up reviews; Council Tuning moves into a standalone bottom section linked from the page sidebar.

- Add private AubOS Council Tuning with actual report comparison, retained instruction provenance, immutable drafts and explicitly started bounded native previews. Draft saves and previews do not promote production configuration or change schedules.

- Let direct AubOS owner task edits retain exact unchanged historical missing-evidence defects, with an audit receipt. Validate new and changed records, references, written bytes and manifest entries, and roll back failures. Keep Council publication and proposal acceptance policies unchanged.

- Show only the active workspace icon in the mobile switcher, falling back to the first letter of its display name. Keep the full name accessible and preserve desktop labels.

- Fill private installation icon symbols in solid white so their interiors contrast with the titanium background; refresh icon URLs for Safari installation.

- Round browser favicon corners, refresh private workspace icon URLs, serve installation manifests as JSON, and provide a high-resolution Apple touch icon. Replace the stale shared A fallback with the neutral Vorton mark.

- Hide repeated page titles on mobile while preserving accessible headings, descriptions and actions. Compact mobile tool cards with icons and status on the left and titles and descriptions on the right.

- Prefix the private AubOS and FreedOS navbar labels with their selected falcon and F silhouettes, inheriting the label color and scale through the shared workspace selector.

- Gate daily Omi Council review on a completed bounded scan, preserving unverified cloud coverage and deferring failures before review admission. Index encrypted archives by opaque day tokens, cache encrypted evidence pages, and bound historical metadata selection so routine reads do not decrypt years of transcripts.

- Add workspace-specific titanium favicons and Safari installation icons to the private AubOS and FreedOS frontend, with separate web-app identities and high-resolution maskable artwork.
- Preserve legacy Admin page titles and not-found titles when attaching native workspace metadata.

- Keep completed planning history out of the daily Council context beyond explicit recent windows, while preserving all unfinished work and unresolved proposals. Prioritize the current due Council before historical catch-up.

- Allow native Council publication to use explicit, owner-recorded exceptions for unchanged historical evidence references. Keep new references and planning changes under strict validation, and include unavailable evidence in review packets and audit reports.

- Lead Council pages with the timeline, fade its viewport edges, and group goal details into sub-cards with the agent prompt action on the right. Remove repeated persona disclaimers from Council reading surfaces and future review prompts.

- Redesign Omi setup around connection, archive and Council state, with one atomic Save changes action shared with Admin settings. Keep unreviewed transcript versions queued across failed reviews and late arrivals, and acknowledge them only after a durable Council receipt.

- Reorganize Admin into a shared directory with independent settings, integrations, Omi, data exports, activity and decision pages. Keep native review and evidence destinations separate instead of appending unrelated panels below Review.

- Explain where to generate a restricted Omi Developer key directly in Admin, including one-time secret display and replacement instructions.

- Add workspace-scoped Omi administrative setup, encrypted credential and transcript storage, bounded direct API retrieval, historical backfill and manual replay. Keep model processing in the existing Paseo workflow and make unverified source coverage explicit.

- Reset Omi scan offsets and evidence receipts when deleting local history, and surface historical retrieval failures in Council evidence.

- Preserve productive Omi backfill progress across multiple weeks instead of restarting it on a weekly timer.

- Add guarded recovery for an unpublished Factory attempt whose approved base advanced. Preserve its claim, scheduler run, custody history and original workspace while preparing a separately approved base revision. Incomplete metadata transactions block controller startup.

- Automatically queue missing Council dates from activation onward, oldest first, with labeled current-evidence catch-up reports. Drain bounded batches on each heartbeat while preserving receipt deduplication, profile isolation, cooldowns, and retry limits.

## 0.2.0-preview.5, September 28, 2026

- Patch the dependency trees used by local validation and production builds. Keep the existing Vinext integration and pin its image parser to a patched compatible release.
- Use compact loading indicators for embedded Bridge cards so loading a Council briefing or vocabulary card does not reserve a full viewport.
- Reveal the Council body after its lazy history loads, preventing Goals and Review from jumping down when the Roundtable arrives. Preserve section links and the Roundtable layout.

## 0.2.0-preview.4, September 19, 2026

- Update the installed React runtime and server decoder to 19.2.8 to fix CVE-2026-44907 before the private production rollout. Keep application releases independent of governed evidence refreshes.

## 0.2.0-preview.3, September 19, 2026

- Preserve restoration of older backups when additive business fields are absent, and initialize new preference histories consistently.
- Defer the Bridge vocabulary card's code and styles until that view mounts.
- Add saved Opportunities, Finance, and Admin & Activity sections using the shared workspace shell. Keep pipeline estimates, ledger entries, and forecast assumptions separate.
- Seed three fictional opportunities and four ledger entries in new Last Resort demo stores. Existing stores retain their records and gain empty optional business collections on read.
- Add workspace purpose and default owner settings, scoped exports, record editing history, and opportunity-to-Task drafts.

## 0.2.0-preview.2, unreleased

- Load shared shell styles once per application entry, preserve explicit navigation button behavior, and audit accessibility through the shared components.
- Require a trusted host, project, and repository binding before Factory queue admission and attempt preparation. Removed or mismatched projects hold work without recreating them.
- Retain Factory workspace membership across retries and recovery. Uncertain workspace creation and removed registrations hold for reconciliation instead of creating duplicates.
- Add a shared Tools shelf with Last Resort room-shuffle and breakfast planners, explicit assumptions, bounded calculations, and editable Task drafts.
- Replace the separate Last Resort shell with shared workspace toolbar, menu, theme, zoom, navigation, fonts, and background components. Share appearance across organizations and replace static demo copy with record-driven Bridge and Organization views.

## 0.2.0-preview.1, September 18, 2026
- Compress Last Resort static assets with the shared production delivery policy while preserving private response freshness and workspace isolation.
- Adopt the MIT license for the portable Vorton preview.
- Configure the local Council due time for 4 a.m. Pacific; matching heartbeat activation remains pending scheduler admission recovery.
- Repair relocated font caches before application builds so reviewed fonts load from production assets without refreshing evidence or downloading replacements.
- Enlarge the Council Orrery on desktop and phone while retaining crossing orbits and portrait clearance.
- Refine Council into a single illustrated Roundtable with an aligned Orrery, animated anchored submissions, a viewport-wide historical timeline, and a calendar picker.
- Keep Council decisions across daily sessions, add a visible report preview with in-place expansion, and reuse section navigation for Timeline, Roundtable, Report, Goals, and Review.
- Support persistent nightly Council heartbeats with profile-scoped publication receipts and bounded recovery, without spawning workspaces for each run.
- Size the Council orrery from the responsive identity ring, preserving its orbit shapes and portrait clearance.
- Restore crossing orbits beyond the outer circles. Replace dense session previews with recorded next decisions, an animated report accordion, and an accent ghost toggle.
- Remove repository quota verification and weekly allowance floors; future controls belong in the Paseo scheduler.
- Fix theme link defaults overriding button and navigation text colors in the installed AubOS interface.
- Add The Last Resort, a fictional hotel workspace with populated Goals, Tasks, staff, and Council recommendations.
- Add a standalone portable demo host with explicit workspace admission and isolated runtime state.
- Show the installed process version as the final item in the upper-left menu.
- Prepare an explicit portable source inventory and release audit workflow. Publication remains gated on owner confirmation.
- Preserve restoration of older two-installation backups while allowing the added demonstration workspace.
