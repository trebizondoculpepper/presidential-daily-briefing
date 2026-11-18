# I built a tool to keep my AI coding agents working on the right things

The biggest problem I've run into as a solo, AI-assisted game developer isn't getting an agent to write code. It's keeping several agents busy on useful work without gradually turning the game's architecture into a pile of tactical fixes.

An agent will often take the shortest route to whatever you've asked for, even when that cuts across the structure you were trying to maintain. The first results look great. Later, apparently simple changes start consuming far more time and tokens than you expected.

That made me wonder whether I really needed another expensive AI subscription—or whether I needed to organize the work better first.

So I built **Presidential Daily Briefing (PDB)**: a free, open-source tool that helps coding agents decide what to work on next. It works through a CLI or MCP server, using Git and the GitHub CLI you already have installed and your existing GitHub authentication.

The workflow is deliberately simple and opinionated:

- **Designers** help the human turn ideas into small, clearly specified tickets, estimate complexity and impact, and sort out dependencies and unanswered questions.
- **Implementers** deliver working code and follow their pull requests through review, fixes and merging. Opening a PR isn't the finish line.

The core is a rules-based prioritization engine written in **Datalog**. There's something pleasingly ironic about using old-school symbolic AI to help newer AI with something it can struggle with: applying the same rules consistently.

Instead of repeatedly asking an LLM to improvise a project plan, the tool gives it a structured answer to: **“What should I work on next to move this project forward?”** That includes following up existing PRs and finding work that unblocks other tickets.

It doesn't magically guarantee good architecture. My aim is to make the intended architecture, acceptance criteria and priorities explicit enough that agents spend less effort guessing—and I spend less effort cleaning up afterward.

I'm building it primarily for a solo developer trying to get more useful work out of several AI accounts. It's intended for workflows using Claude Code, Codex, OpenCode, Ori and other CLI/MCP-capable agents, rather than tying everything to one model provider. Integrations are still evolving.

If you're curious, the website is **https://pdb.stodge.org/**. It's free to install from npm:

```sh
npm install -g @trebizondoculpepper/presidential-daily-briefing
```

I'd love to hear whether this helps anyone else's game-dev workflow. Try it, tell me where it falls down, [open a ticket](https://github.com/trebizondoculpepper/presidential-daily-briefing/issues), or contact me directly. I'm actively investing time in improving it, and real experiences from other developers would be especially useful.

How are you keeping multiple coding agents productive without losing control of your project's structure?
