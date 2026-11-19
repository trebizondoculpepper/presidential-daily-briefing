/**
 * The shared controversial-items read service (#1099, doc/design/estimation-refinement-loop.md
 * "Discussion view"). One typed, transport-neutral result: GitHub's total comment counts are read
 * through the typed GH capability (`discussionPage`), and inclusion, order and explanation come
 * from the native policy (`evaluateDiscussion`, #1093). CLI, MCP and serve render this result;
 * none recomputes it. Caching belongs to the consuming transport's shared cache, as for metrics.
 */
import type { DiscussionNode } from "../github/service/snapshot.js";
import type { GhService } from "../github/service/service.js";
import { evaluateDiscussion } from "../rules/datalog/engine.js";

export type DiscussionScope = "open" | "closed" | "all";

export interface DiscussionItem {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  comments: number;
  /** 1-based native rank among the items read. */
  rank: number;
  /** The native policy's explanation. */
  why: string;
}

export interface DiscussionView {
  schemaVersion: 1;
  kind: "discussion-view";
  repository: string;
  scope: DiscussionScope;
  fetchedAt: string;
  items: DiscussionItem[];
  /** Issues whose comment count was not read: unknown, never zero, never ranked. */
  unknown: { number: number; title: string; url: string }[];
  coverage: {
    /** True only when every issue in scope was read. */
    complete: boolean;
    pagesRead: number;
    issuesRead: number;
    /** Nodes the answer did not carry readably; counted, never dropped silently. */
    unreadable: number;
    /** Why coverage is partial, when it is; the ranking is then not repository-wide. */
    note: string | null;
  };
  policyVersion: number;
  rulesHash: string;
}

export interface DiscussionOptions {
  repository: string;
  scope: DiscussionScope;
  /** The application's GH facade (only the discussion read is used). */
  gh: { snapshot: Pick<GhService["snapshot"], "discussionPage"> };
  /** Bounded read: at most `maxPages` pages of `pageSize` issues. */
  bounds?: { maxPages?: number; pageSize?: number };
  now?: () => Date;
  signal?: AbortSignal;
}

const DEFAULT_PAGES = 10;
const DEFAULT_PAGE_SIZE = 100;

/** Read the discussion view for one repository and scope, bounded and cancellable. */
export async function readDiscussion(options: DiscussionOptions): Promise<DiscussionView> {
  const maxPages = options.bounds?.maxPages ?? DEFAULT_PAGES;
  const pageSize = options.bounds?.pageSize ?? DEFAULT_PAGE_SIZE;
  const nodes: DiscussionNode[] = [];
  let unreadable = 0;
  let pagesRead = 0;
  let cursor: string | null = null;
  let more = true;
  while (more && pagesRead < maxPages) {
    options.signal?.throwIfAborted();
    const page = await options.gh.snapshot.discussionPage(
      options.repository,
      options.scope,
      pageSize,
      cursor,
      options.signal,
    );
    pagesRead++;
    for (const node of page.nodes) {
      if (node) nodes.push(node);
      else unreadable++;
    }
    more = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }
  options.signal?.throwIfAborted();
  const capped = more;
  const native = evaluateDiscussion({
    scope: options.scope,
    issues: nodes.map((n) => ({ number: n.number, state: n.state, comments: n.comments })),
  });
  const byNumber = new Map(nodes.map((n) => [n.number, n]));
  const notes = [
    ...(capped
      ? [
          `Read ${pagesRead} page(s) of ${pageSize} issues and stopped at the bound; more issues exist, so this ranking is not repository-wide.`,
        ]
      : []),
    ...(unreadable ? [`${unreadable} issue(s) could not be read and are not ranked.`] : []),
    ...(native.unknown.length
      ? [
          `${native.unknown.length} issue(s) have an unknown comment count and are not ranked, so the ranking may omit them.`,
        ]
      : []),
  ];
  return {
    schemaVersion: 1,
    kind: "discussion-view",
    repository: options.repository,
    scope: options.scope,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    items: native.items.map((item, i) => {
      const node = byNumber.get(item.number)!;
      return {
        number: item.number,
        title: node.title,
        url: node.url,
        state: node.state,
        comments: item.comments,
        rank: i + 1,
        why: item.why,
      };
    }),
    unknown: native.unknown.map((number) => {
      const node = byNumber.get(number)!;
      return { number, title: node.title, url: node.url };
    }),
    coverage: {
      complete: !capped && unreadable === 0 && native.unknown.length === 0,
      pagesRead,
      issuesRead: nodes.length,
      unreadable,
      note: notes.length ? notes.join(" ") : null,
    },
    policyVersion: native.policyVersion,
    rulesHash: native.rulesHash,
  };
}
