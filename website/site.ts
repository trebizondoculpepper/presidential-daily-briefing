import { pages, repository } from "./content.js";
import { conversations } from "./conversations.js";

/** Presentation input only. #601 owns capture validation and release provenance. */
export interface SiteInput {
  release?: { version: string; gitHead: string; capturedAt: string };
  examples: {
    id: string;
    title: string;
    command: string;
    output: string;
    provenance: string;
    notices: string[];
  }[];
}
const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
const command = (text: string, id: string): string =>
  `<div class="command"><pre><code id="${id}">${escape(text)}</code></pre><button type="button" data-copy="${id}" hidden>Copy command</button></div>`;

export function renderSite(input: SiteInput): Map<string, string> {
  if (input.examples.length && !input.release) {
    throw new Error("Captured examples require release provenance.");
  }
  const release = input.release;
  const version = release
    ? `<a href="${repository}/releases/tag/v${encodeURIComponent(release.version)}">pdb ${escape(release.version)}</a>`
    : "Local preview · no documented release";
  const renderExamples = (examples: SiteInput["examples"]): string =>
    examples.length
      ? examples
          .map(
            (example, index) =>
              `<article class="terminal"><details${example.id === "implementer-live" ? " open" : ""}><summary class="terminal-bar"><span>READOUT / ${String(index + 1).padStart(2, "0")}</span><span>${escape(example.title)}</span></summary>${command(example.command, `example-${index}`)}<pre class="output"><code>${escape(example.output)}</code></pre><p class="provenance">${escape(example.provenance)}</p>${example.notices.map((notice) => `<p class="notice">${escape(notice)}</p>`).join("")}</details></article>`,
          )
          .join("")
      : `<div class="empty"><strong>NO RELEASE CAPTURE LOADED</strong><p>This preview contains no release-validated command output. The release capture pipeline supplies dated examples, coverage notices and artifact provenance before publication.</p></div>`;
  return new Map(
    pages.map((page, index) => {
      const root = page.path ? "../" : "./";
      const groups = [
        ["implementer-live"],
        ["rules", "implementer-live"],
        ["version", "help", "onboarding-help"],
        ["implementer-live", "designer-offline", "human-offline"],
      ];
      const known = new Set(groups.flat());
      const examples = renderExamples(
        input.examples.filter(
          (example) => !known.has(example.id) || groups[index]!.includes(example.id),
        ),
      );
      const navigation = pages
        .map(
          (entry) =>
            `<a href="${root}${entry.path ? `${entry.path}/` : ""}"${entry.path === page.path ? ' aria-current="page"' : ""}>${escape(entry.label)}</a>`,
        )
        .join("");
      const install = `<section class="quickstart" aria-labelledby="install-title"><div><p class="eyebrow">START HERE</p><h2 id="install-title">Install. Choose a repository.</h2><p>${release ? "Pin the documented release to reproduce these examples. Use @latest instead to install or update to the newest stable version." : "Syntax preview only. These commands have not been release-validated by this preview build."}</p></div><div>${command(`npm install -g @trebizondoculpepper/presidential-daily-briefing@${release?.version ?? "latest"}`, "install")}${command("pdb --repo owner/repository", "first-briefing")}${command("pdb --help", "help")}</div></section>`;
      const sections = page.sections
        .map(
          (section, sectionIndex) =>
            `<section class="chapter"><span class="chapter-number" aria-hidden="true">${String(sectionIndex + 1).padStart(2, "0")}</span><div><h2>${escape(section.title)}</h2>${section.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}</div></section>`,
        )
        .join("");
      const conversationGallery =
        page.path === "use-cases"
          ? `<section class="conversations" id="conversation-examples" aria-labelledby="conversations-title"><p class="eyebrow">PDB IN CONVERSATION</p><h2 id="conversations-title">Project briefings, in conversation.</h2><p>An assistant uses PDB evidence to explain priorities, identify decisions for a human and summarise project changes. These conversations from 17 November 2026 are historical examples: ticket statuses, recommendations and release availability may have changed.</p><p>Select an image to view the full screenshot; the previews show only the top portion. Each caption describes the capability illustrated.</p><div class="conversation-grid">${conversations
              .map(
                (item) =>
                  `<figure class="conversation"><a class="conversation-image" href="${root}assets/conversations/${escape(item.file)}" aria-label="View full screenshot: ${escape(item.title)}"><img src="${root}assets/conversations/${escape(item.file)}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async" alt="${escape(item.alt)}"></a><figcaption><h3>${escape(item.title)}</h3><p>${escape(item.caption)}</p><a href="${root}assets/conversations/${escape(item.file)}">View full screenshot</a></figcaption></figure>`,
              )
              .join("")}</div></section>`
          : "";
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${release ? `<meta name="pdb-version" content="${escape(release.version)}"><meta name="pdb-source" content="${escape(release.gitHead)}">` : ""}<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escape(page.intro)}"><title>${escape(page.label)} · Presidential Daily Briefing</title><link rel="stylesheet" href="${root}assets/site.css"><script type="module" src="${root}assets/copy.js"></script></head><body><a class="skip" href="#main">Skip to content</a><header class="masthead"><a class="brand" href="${root}"><span aria-hidden="true">[ PDB ]</span><span>Presidential<br>Daily Briefing</span></a><nav aria-label="Main navigation">${navigation}</nav><a class="source" href="${repository}">GitHub ↗</a></header><main id="main"><section class="hero"><p class="eyebrow">${escape(page.eyebrow)} <span aria-hidden="true">/ ${String(index + 1).padStart(2, "0")}</span></p><h1>${escape(page.title)}</h1><p class="intro">${escape(page.intro)}</p><p class="build-label">${version}</p></section>${index === 0 || index === 2 ? install : ""}${index === 0 ? `<p class="conversation-link"><a href="${root}use-cases/#conversation-examples">See PDB in conversation</a>: priorities, human decisions and project catch-ups.</p>` : ""}<div class="chapters">${sections}</div>${conversationGallery}<section class="examples" aria-labelledby="examples-title"><p class="eyebrow">CHECK THE EVIDENCE</p><h2 id="examples-title">A briefing, with its limits.</h2>${release ? `<p>Documented release ${escape(release.version)} · source <code>${escape(release.gitHead)}</code> · captured ${escape(release.capturedAt)}. Examples are dated observations, not a live view.</p>` : ""}${examples}</section><aside class="next"><span>KEEP EXPLORING</span><a href="${root}${pages[(index + 1) % pages.length]!.path ? `${pages[(index + 1) % pages.length]!.path}/` : ""}">${escape(pages[(index + 1) % pages.length]!.label)} →</a></aside></main><footer><p>${version}</p><p><a href="${repository}/blob/${release ? escape(release.gitHead) : "main"}/doc/design/public-website.md">Website contract</a> · <a href="${repository}/issues">Questions &amp; issues</a> · <a href="${repository}/blob/${release ? escape(release.gitHead) : "main"}/LICENSE">License</a></p><p>No visitor-side GitHub calls. No analytics. No hook required.</p></footer><p role="status" aria-live="polite" class="copy-status" id="copy-status"></p></body></html>`;
      return [`${page.path ? `${page.path}/` : ""}index.html`, html];
    }),
  );
}
