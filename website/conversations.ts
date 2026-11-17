/** Owner-supplied editorial illustrations, separate from release command captures. */
export const conversations = [
  {
    file: "implementer-priorities.png",
    sha256: "9a8c7610ab339f28be38df9953d1cffd55e181b41901421d9d39edd272b72374",
    width: 1080,
    height: 3419,
    title: "What should the implementer do next?",
    alt: "An assistant answers a request for implementer priorities with pull-request follow-up and a ranked list of ready tickets.",
    caption:
      "PDB supplies the ranked work and blocker evidence; the assistant turns it into a briefing. This example puts existing pull-request follow-up before new work and explains which fixes would unlock other tickets. Planned features mentioned in the conversation are not claims that they have shipped.",
  },
  {
    file: "human-attention.png",
    sha256: "968525c13fb3224e5eba55b1b6544c6e1ac9b68d6e8debddf98a57eeb4029218",
    width: 1080,
    height: 2045,
    title: "Does anything need my attention?",
    alt: "An assistant distinguishes pending licensing research and optional cache experiments from technical fixes that agents can handle.",
    caption:
      "The human-attention view helps an assistant separate decisions for the developer from work agents can continue. Here it explains why a flagged issue can wait for research instead of asking the human to decide prematurely.",
  },
  {
    file: "project-catch-up.jpg",
    sha256: "784184c7d26e86240646050166da05e598248d23744730a66d49df78757e1f9b",
    width: 570,
    height: 1280,
    title: "What changed since we last spoke?",
    alt: "An assistant summarises three merged changes and explains that they landed after the installed release.",
    caption:
      "A repository catch-up becomes a concise explanation of merged changes. The assistant distinguishes completed backend work from an unfinished page, and changes on main from features available in the installed release.",
  },
] as const;
