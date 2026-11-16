# Shared served-page shell acceptance (#605)

2026-11-16, macOS 26, native Google Chrome. Implemented against the merged [served-page shell contract](../design/served-page-shell.md). The browser-access host was unavailable; native accessibility and screenshot access worked. No browser automation dependency was added.

## Automated evidence

The shared registry supplies HTML parameter allowlists and page/link scopes. Tests cover canonical served spelling; absent selection with one or many projects; malformed, unserved and repeated inputs; equivalent Work/Ticket role and agent carry; removal of unrelated page filters; hostile link encoding; active page/project indication; shared HTML errors and security headers; no data fetch on an unselected Work page; cancellation and late/foreign answer isolation; history restoration; and updating toolbar carry values after in-page changes. Packaged smoke checks every shipped HTML route. JSON and MCP behavior retain their existing tests.

The final full suite passed 2,423 tests (one skipped), including the carry-link regression. Checks and build passed. The installed-package smoke test also covers every shipped HTML route.

## Visual evidence

A temporary TypeScript preview outside the repository injected a synthetic 50-ticket briefing and a fixed two-project served set. It used the real server/router/renderers and no GitHub credentials or remote collector. Text in screenshots explicitly identifies the fixture. Captures use Chrome's device toolbar at 100% browser zoom, 800 CSS pixels high and device pixel ratio 2; file dimensions are twice the CSS viewport dimensions. These are synthetic layout artifacts, not live GitHub snapshots.

| CSS width | Work, light                                   | Work, dark                                   | 403 error, light                               | 403 error, dark                               |
| --------- | --------------------------------------------- | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| 320       | [image](assets/605-shell/work-light-320.png)  | [image](assets/605-shell/work-dark-320.png)  | [image](assets/605-shell/error-light-320.png)  | [image](assets/605-shell/error-dark-320.png)  |
| 390       | [image](assets/605-shell/work-light-390.png)  | [image](assets/605-shell/work-dark-390.png)  | [image](assets/605-shell/error-light-390.png)  | [image](assets/605-shell/error-dark-390.png)  |
| 768       | [image](assets/605-shell/work-light-768.png)  | [image](assets/605-shell/work-dark-768.png)  | [image](assets/605-shell/error-light-768.png)  | [image](assets/605-shell/error-dark-768.png)  |
| 1280      | [image](assets/605-shell/work-light-1280.png) | [image](assets/605-shell/work-dark-1280.png) | [image](assets/605-shell/error-light-1280.png) | [image](assets/605-shell/error-dark-1280.png) |

Work captures are scrolled into the long list: the toolbar remains visible. Narrow layouts use the Pages disclosure. The selected project and menu stay readable, with no horizontal page overflow observed. Error pages keep navigation without overlapping their footer. The dark error color was brightened after actual inspection.

Additional native-browser observations:

- Rules deep-link `#section-3` leaves the heading below the toolbar.
- Shift-Tab reaches the visible Skip to content link; Enter moves accessibility focus into the main region.
- Keyboard Enter opens and closes Change project; Tab through the project links and Enter switches project while remaining on Rules. Page-specific filters are dropped. The long project name wraps at 320 CSS pixels.
- At a 320 × 400 CSS viewport the toolbar is static and scrolls away, leaving room for content.
- Actual browser zoom at 200% and 400%, with device emulation closed, reflows navigation without horizontal overflow. At 400% the short-height rule makes the toolbar static. Browser zoom was restored to 100%.
- Setup without a selection shows generic placeholders and the same navigation. No implicit single-project selection was made.

VoiceOver audio/announcement verification is pending explicit permission to temporarily enable and restore the Mac accessibility setting. Accessibility-tree and keyboard inspection are recorded above and are not represented as a VoiceOver audio pass.
