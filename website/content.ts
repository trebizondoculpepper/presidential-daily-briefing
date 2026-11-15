export const repository = "https://github.com/trebizondoculpepper/presidential-daily-briefing";

export interface Section {
  title: string;
  paragraphs: string[];
}
export interface Page {
  path: string;
  label: string;
  eyebrow: string;
  title: string;
  intro: string;
  sections: Section[];
}
export const pages: Page[] = [
  {
    path: "",
    label: "Home",
    eyebrow: "Presidential Daily Briefing",
    title: "Less babysitting. A clearer next step.",
    intro:
      "PDB turns GitHub evidence into prioritized work for implementers, designers and the humans directing them. Ask what needs attention, follow the evidence, then act with your existing tools.",
    sections: [
      {
        title: "Start with what matters",
        paragraphs: [
          "An agent can finish a change and still miss the work that makes it useful: a review finding, a failing check, a decision on its ticket, or the last dependency blocking someone else. Repeating those reminders by hand takes attention away from the project.",
          "PDB reads repository facts and applies explicit workflow rules. The briefing brings together addressed requests, review follow-up, continuing responsibility and eligible pickup. Native GitHub dependencies help distinguish work that is ready from work that only looks ready in an issue description. Each action links back to the evidence that explains it.",
        ],
      },
      {
        title: "One project, different responsibilities",
        paragraphs: [
          "Implementers need to finish review follow-up before collecting new tickets. Designers need to resolve questions, clarify contracts and assess useful work. A human director needs the requests and sign-offs waiting for their input. Role-shaped views make those different questions easier to answer without treating a name or role as permission to write.",
          "Start with the command line. MCP offers another way for a compatible client to read the same project context. Optional before-stop integrations can ask the shared rebrief core whether useful work remains; native continuation depends on the client and its tested capabilities. You can use PDB without installing a hook.",
        ],
      },
      {
        title: "Evidence includes its limits",
        paragraphs: [
          "A briefing is advice grounded in an observation, not proof that the whole repository is current. Missing permissions, incomplete reads, stale snapshots and unknown estimates must remain visible. Read those notices before acting; absence of evidence is not approval.",
          "PDB does not promise that an agent will autonomously finish a project. It gives the agent and the person directing it a checkable next step. Examples carry their release, observation time and coverage. Read them as dated evidence rather than a live board.",
        ],
      },
    ],
  },
  {
    path: "how-it-works",
    label: "How it works",
    eyebrow: "Facts → rules → next steps",
    title: "A queue you can question.",
    intro:
      "PDB collects GitHub evidence, evaluates registered workflow rules and presents the actions relevant to a role. The explanation travels with the recommendation.",
    sections: [
      {
        title: "Read the project",
        paragraphs: [
          "Issues, pull requests, labels, reviews, checks and native dependency relationships describe different parts of the work. PDB gathers that evidence with explicit freshness and completeness. A ticket body can explain intent, but it does not replace a native blocked-by relationship or a current review result.",
          "Collection has limits. Access may be incomplete, a quota may interrupt a read, or an offline snapshot may be older than the change you are investigating. The resulting notices belong beside the recommendation. A partial result must not quietly become a confident all-clear.",
        ],
      },
      {
        title: "Apply an explicit policy",
        paragraphs: [
          "Registered rules connect the facts to useful actions. Review follow-up and addressed requests compete with ordinary pickup in a role-shaped queue. Dependency reasoning can identify a ticket whose completion would unblock downstream work. Estimates describe expected benefit and effort; an unknown estimate stays unknown.",
          "Use the released rules and help output to inspect the policy instead of relying on a frozen copy in a prompt. A rule can explain why work was recommended, but the agent still needs to read the ticket, inspect current ownership and verify its prerequisites. A recommendation is not authorization to merge, publish or overwrite another contributor's work.",
        ],
      },
      {
        title: "Continue through a small adapter",
        paragraphs: [
          "The intended hook boundary is thin: the native event adapter translates its client's input, calls the packaged shared rebrief core and translates the result back. The common decision belongs in PDB so clients can share fixes, tests and policy without each maintaining a second workflow engine.",
          "The client owns event delivery, trust, response handling, model-visible continuation and cancellation. A watcher that starts another turn is different from a before-stop veto. Controlled CLI trials do not establish hosting-app support or production installation. User interruption wins; caps and reentry protection bound continuation. Consult the release-specific capability evidence before choosing an integration.",
        ],
      },
    ],
  },
  {
    path: "getting-started",
    label: "Getting started",
    eyebrow: "Install / inspect / brief",
    title: "Start with one repository.",
    intro:
      "Use the released command line first. Add identity, MCP or native continuation only when your workflow needs them and the documented release supports them.",
    sections: [
      {
        title: "Prepare your own environment",
        paragraphs: [
          "Install Node and npm using the project's current-LTS policy and the documented package's engine requirements. Install GitHub CLI and authenticate it yourself for the repository you intend to read. Installing PDB does not install Node or grant GitHub access.",
          "The package is @trebizondoculpepper/presidential-daily-briefing. A global installation provides the pdb command. Using @latest installs the stable release; pinning an exact version is useful for a reproducible environment. The next tag is an opt-in prerelease channel and may change independently of the stable documentation.",
        ],
      },
      {
        title: "Read before changing anything",
        paragraphs: [
          "Choose your repository explicitly for the first briefing. Inspect the output's observation time, missing-evidence notices and source links. Use help for the exact installed release when a command or option differs from the documentation. A local preview of this website is not evidence that a command has been tested against a published artifact.",
          "A read-only briefing is a useful starting point without a claim or hook. When local identity is needed, use the released setup command and keep the generated project configuration private. Do not hand-edit another agent's name into a file. A human routing view is distinct from persistent implementer/designer identity and does not grant authority.",
        ],
      },
      {
        title: "Add only what you need",
        paragraphs: [
          "A compatible MCP client can obtain project context through the released server interface. An optional local served dashboard offers another read surface. Follow the release's verified setup guidance for selecting a project; do not assume a client launched in a different directory has selected the same repository.",
          "Native continuation is optional. Check the tested platform/version and user-stop limitations before installing an integration. A design document for an installer is not a shipped installer. If setup fails, keep the error and consult the installed help and repository guidance. Do not solve a missing capability by copying experimental trial flags into your everyday configuration.",
        ],
      },
    ],
  },
  {
    path: "use-cases",
    label: "Use cases",
    eyebrow: "Different roles / shared evidence",
    title: "Keep the work moving.",
    intro:
      "The useful next step depends on what you are responsible for. These are workflow stories, not claims that the example actions happened in a live repository.",
    sections: [
      {
        title: "Implementer: finish the delivery",
        paragraphs: [
          "You have opened a pull request and could start another issue. First, ask PDB what needs attention. A current review finding or failed required check may be more important than new pickup. Follow its source link, inspect the current head and address the substantive problem before treating the work as delivered.",
          "Once your delivery is complete, inspect eligible work and native blockers. A small ticket that removes the last blocker for several dependants can matter more than a newly opened feature. Check ownership before claiming, use the project's supported coordination commands and keep the ticket updated when a concrete blocker prevents progress.",
        ],
      },
      {
        title: "Designer: turn uncertainty into a contract",
        paragraphs: [
          "An implementer cannot responsibly guess a product decision. The designer view brings design work, questions and assessments into focus. Read the request and its downstream impact, resolve the decision in a durable contract, and make the implementation handoff clear enough to review.",
          "An assessment is evidence about benefit or complexity, not a claim and not an automatic unblock. Keep assumptions visible and revise them when new information changes the expected work. A merged design can enable implementation without completing the feature's acceptance or its empirical follow-up.",
        ],
      },
      {
        title: "Human director: supply the missing input",
        paragraphs: [
          "You do not need another generic list of every open issue. You need the question, sign-off or addressed request that needs your input, with a link to the work it blocks. A human routing view helps surface those requests without pretending your routing name is authentication or a new kind of agent identity.",
          "Optional rebrief integrations can reduce repeated prompts after a natural stop, within the client's verified limits. They do not eliminate judgment, authorize releases or override your interruption. When a client lacks a tested native boundary, ordinary CLI or MCP use still provides a useful briefing. Keep the distinction between a suggested next action and an action actually completed visible in your workflow.",
        ],
      },
    ],
  },
];
