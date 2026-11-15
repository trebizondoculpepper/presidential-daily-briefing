/**
 * The host facts `pdb rules` and the serve rules page (#392) both hand to the compiled policy
 * document: declared defaults, the mutating commands whose guards live in TypeScript, and the
 * related process command. One function, so the CLI and the page cannot drift apart.
 */
import { defaultEngineRole } from "../briefing/service.js";
import { defaultPickupOrder } from "../briefing/ranking.js";
import { mutatingCommands, PROCESS_COMMAND } from "../briefing/process.js";
import { CONFIG_KEYS } from "../config/config.js";
import type { RulesContext } from "./datalog/rules-command.js";

/** Declared defaults and boundary; effective settings are never assumed here. */
export function declaredRulesContext(): RulesContext {
  return {
    defaults: [
      ...CONFIG_KEYS.map((k) => ({
        name: k.key,
        value: k.defaultValue,
        declaredBy: "repository setting registry",
      })),
      { name: "--role", value: defaultEngineRole, declaredBy: "briefing, when --role is omitted" },
      {
        name: "--order",
        value: defaultPickupOrder,
        declaredBy: "briefing, when --order is omitted",
      },
      {
        name: "--platform",
        value: "",
        declaredBy: "briefing, when --platform is omitted; the viewer platform is then unknown",
      },
    ],
    mutatingCommands: mutatingCommands(),
    processCommand: PROCESS_COMMAND,
  };
}
